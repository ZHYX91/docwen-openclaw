export const READ_TOOL_NAMES = [
  "docwen_info",
  "docwen_inspect",
  "docwen_resources",
  "docwen_validate_markdown",
] as const;

export const WRITE_TOOL_NAMES = [
  "docwen_convert",
  "docwen_number_markdown",
  "docwen_merge_pdfs",
  "docwen_split_pdf",
  "docwen_merge_tables",
  "docwen_merge_images_to_tiff",
] as const;

export const TOOL_NAMES = [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES] as const;

export type DocWenToolName = (typeof TOOL_NAMES)[number];

export function isOptionalTool(name: DocWenToolName): boolean {
  return (WRITE_TOOL_NAMES as readonly string[]).includes(name);
}
