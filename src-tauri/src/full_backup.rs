//! 一键备份 / 一键恢复：单个 zip 压缩包。
//!
//! 前端负责把作品库、正文、设置等逻辑数据整理成 JSON，字体等二进制按原样传入；
//! 这里只做三件事：暂存前端逐条送来的文件、压成一个包、解包后按条目回读。
//! 提示词是 Documents/易创提示词 下的 md 文件，由这里直接进出压缩包。
//!
//! 大文件（字体可到 50 MB）走 IPC 原始字节体，不经 JSON 序列化。

use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::{InvokeBody, InvokeResponseBody, Request, Response};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// 解包总量上限：防止畸形压缩包把磁盘写满
const MAX_RESTORE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MANIFEST_NAME: &str = "manifest.json";
const PROMPTS_PREFIX: &str = "prompts/";
const HEADER_SESSION: &str = "x-ew-session";
const HEADER_ENTRY: &str = "x-ew-entry";

fn sessions() -> &'static Mutex<HashMap<String, PathBuf>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn new_session(prefix: &str) -> Result<(String, PathBuf), String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let id = format!("{prefix}-{}-{nanos}", std::process::id());
    let dir = std::env::temp_dir().join(format!("ew-{id}"));
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    sessions()
        .lock()
        .map_err(|_| "备份会话锁不可用".to_string())?
        .insert(id.clone(), dir.clone());
    Ok((id, dir))
}

fn session_dir(session: &str) -> Result<PathBuf, String> {
    sessions()
        .lock()
        .map_err(|_| "备份会话锁不可用".to_string())?
        .get(session)
        .cloned()
        .ok_or_else(|| "备份会话不存在或已结束".to_string())
}

fn drop_session(session: &str) {
    if let Ok(mut map) = sessions().lock() {
        if let Some(dir) = map.remove(session) {
            let _ = fs::remove_dir_all(dir);
        }
    }
}

/// 条目名只接受相对路径，拒绝 .. 与盘符（zip-slip）
fn sanitize_entry(entry: &str) -> Result<PathBuf, String> {
    let mut out = PathBuf::new();
    for part in entry.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains(':') {
            return Err(format!("非法的备份条目名：{entry}"));
        }
        out.push(part);
    }
    if out.as_os_str().is_empty() {
        return Err("备份条目名为空".to_string());
    }
    Ok(out)
}

/// 请求头只能放 ASCII，条目名由前端 encodeURIComponent 后传入，这里解回来
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = &value[index + 1..index + 3];
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn header_value(request: &Request<'_>, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .ok_or_else(|| format!("缺少请求头 {name}"))?;
    let text = raw.to_str().map_err(|error| error.to_string())?;
    Ok(percent_decode(text))
}

fn entry_name(root: &Path, path: &Path, prefix: &str) -> Result<String, String> {
    let rel = path.strip_prefix(root).map_err(|error| error.to_string())?;
    let joined = rel
        .components()
        .map(|part| part.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/");
    Ok(format!("{prefix}{joined}"))
}

fn is_prompt_file(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    ext == "md" || ext == "txt"
}

fn add_dir_to_zip(
    writer: &mut ZipWriter<File>,
    root: &Path,
    dir: &Path,
    prefix: &str,
    options: SimpleFileOptions,
    entries: &mut usize,
) -> Result<(), String> {
    let mut items: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|error| error.to_string())?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .collect();
    items.sort();
    for path in items {
        if path.is_dir() {
            add_dir_to_zip(writer, root, &path, prefix, options, entries)?;
            continue;
        }
        if !path.is_file() {
            continue;
        }
        // 提示词目录只带文档，用户随手放进去的其它文件不进包
        if !prefix.is_empty() && !is_prompt_file(&path) {
            continue;
        }
        let name = entry_name(root, &path, prefix)?;
        writer
            .start_file(name, options)
            .map_err(|error| error.to_string())?;
        let mut file = File::open(&path).map_err(|error| error.to_string())?;
        io::copy(&mut file, writer).map_err(|error| error.to_string())?;
        *entries += 1;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullBackupSummary {
    path: String,
    bytes: u64,
    entries: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreEntry {
    path: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullRestoreInfo {
    session: String,
    manifest: String,
    entries: Vec<RestoreEntry>,
}

/// 开始一次备份：建暂存目录，返回会话号
#[tauri::command]
pub fn full_backup_begin() -> Result<String, String> {
    Ok(new_session("backup")?.0)
}

/// 写入一个条目。正文走原始字节体；请求头带会话号与条目名。
#[tauri::command]
pub fn full_backup_add_entry(request: Request<'_>) -> Result<(), String> {
    let session = header_value(&request, HEADER_SESSION)?;
    let entry = header_value(&request, HEADER_ENTRY)?;
    let target = session_dir(&session)?.join(sanitize_entry(&entry)?);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    match request.body() {
        InvokeBody::Raw(bytes) => fs::write(&target, bytes).map_err(|error| error.to_string()),
        InvokeBody::Json(value) => {
            let text = value
                .as_str()
                .map(|text| text.to_string())
                .unwrap_or_else(|| value.to_string());
            fs::write(&target, text).map_err(|error| error.to_string())
        }
    }
}

/// 把暂存目录（可选加上提示词目录）压成目标 zip，随后清理暂存
#[tauri::command]
pub fn full_backup_finish(
    session: String,
    target_path: String,
    include_prompts: bool,
) -> Result<FullBackupSummary, String> {
    let dir = session_dir(&session)?;
    let result = (|| {
        let target = PathBuf::from(&target_path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let file = File::create(&target).map_err(|error| format!("无法创建备份文件：{error}"))?;
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .large_file(true);
        let mut entries = 0usize;
        add_dir_to_zip(&mut writer, &dir, &dir, "", options, &mut entries)?;
        if include_prompts {
            if let Ok(prompt_dir) = crate::prompt_dir_path() {
                if prompt_dir.is_dir() {
                    add_dir_to_zip(&mut writer, &prompt_dir, &prompt_dir, PROMPTS_PREFIX, options, &mut entries)?;
                }
            }
        }
        writer.finish().map_err(|error| error.to_string())?;
        let bytes = fs::metadata(&target).map(|meta| meta.len()).unwrap_or(0);
        Ok(FullBackupSummary {
            path: target.to_string_lossy().to_string(),
            bytes,
            entries,
        })
    })();
    drop_session(&session);
    result
}

/// 打开备份包：校验 manifest、解到暂存目录，返回会话号与条目清单
#[tauri::command]
pub fn full_restore_open(zip_path: String) -> Result<FullRestoreInfo, String> {
    let file = File::open(&zip_path).map_err(|error| format!("无法打开备份文件：{error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("不是有效的压缩包：{error}"))?;
    if archive.by_name(MANIFEST_NAME).is_err() {
        return Err("这不是易创的一键备份文件（缺少 manifest.json）".to_string());
    }
    let (session, dir) = new_session("restore")?;
    let result = (|| {
        let mut entries = Vec::new();
        let mut manifest = String::new();
        let mut total: u64 = 0;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
            if entry.is_dir() {
                continue;
            }
            let Some(rel) = entry.enclosed_name() else {
                return Err(format!("备份包内含非法路径：{}", entry.name()));
            };
            total += entry.size();
            if total > MAX_RESTORE_BYTES {
                return Err("备份包解开后超过 4 GB 上限".to_string());
            }
            let target = dir.join(&rel);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let mut out = File::create(&target).map_err(|error| error.to_string())?;
            io::copy(&mut entry, &mut out).map_err(|error| error.to_string())?;
            let name = entry_name(&dir, &target, "")?;
            if name == MANIFEST_NAME {
                manifest = fs::read_to_string(&target).map_err(|error| error.to_string())?;
            }
            entries.push(RestoreEntry { path: name, size: entry.size() });
        }
        Ok(FullRestoreInfo {
            session: session.clone(),
            manifest,
            entries,
        })
    })();
    if result.is_err() {
        drop_session(&session);
    }
    result
}

/// 按条目名回读原始字节（前端拿到 ArrayBuffer）
#[tauri::command]
pub fn full_restore_read_entry(session: String, path: String) -> Result<Response, String> {
    let target = session_dir(&session)?.join(sanitize_entry(&path)?);
    let bytes = fs::read(&target).map_err(|error| format!("读取备份条目失败（{path}）：{error}"))?;
    Ok(Response::new(InvokeResponseBody::Raw(bytes)))
}

/// 把包里的提示词文档写回提示词目录。overwrite=先清空再写；merge=只补缺失的文件
#[tauri::command]
pub fn full_restore_apply_prompts(session: String, mode: String) -> Result<usize, String> {
    let source = session_dir(&session)?.join("prompts");
    if !source.is_dir() {
        return Ok(0);
    }
    let prompt_dir = crate::ensure_prompt_dir()?;
    if mode == "overwrite" {
        for entry in fs::read_dir(&prompt_dir).map_err(|error| error.to_string())? {
            let path = entry.map_err(|error| error.to_string())?.path();
            if path.is_file() && is_prompt_file(&path) {
                fs::remove_file(&path).map_err(|error| error.to_string())?;
            }
        }
    }
    let mut count = 0usize;
    for entry in fs::read_dir(&source).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if !path.is_file() || !is_prompt_file(&path) {
            continue;
        }
        let Some(name) = path.file_name() else { continue };
        let target = prompt_dir.join(name);
        if mode != "overwrite" && target.exists() {
            continue;
        }
        fs::copy(&path, &target).map_err(|error| error.to_string())?;
        count += 1;
    }
    Ok(count)
}

/// 结束恢复会话，清理暂存目录
#[tauri::command]
pub fn full_restore_close(session: String) {
    drop_session(&session);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_handles_utf8_and_plain() {
        assert_eq!(percent_decode("fonts%2Fabc.ttf"), "fonts/abc.ttf");
        assert_eq!(percent_decode("%E6%8F%90%E7%A4%BA.md"), "提示.md");
        assert_eq!(percent_decode("plain"), "plain");
    }

    #[test]
    fn sanitize_entry_rejects_traversal() {
        assert!(sanitize_entry("../x").is_err());
        assert!(sanitize_entry("C:\\x").is_err());
        assert_eq!(sanitize_entry("a/./b//c.json").unwrap(), PathBuf::from("a").join("b").join("c.json"));
    }
}
