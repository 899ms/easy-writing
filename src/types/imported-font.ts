export interface ImportedFont {
  id: string
  name: string
  createdAt: number
}

export interface ImportedFontOption extends ImportedFont {
  value: string
}
