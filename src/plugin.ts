import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

import { docwenConfigSchema } from "./config.js";
import { defineDocWenTools } from "./tools/definitions.js";

export const docwenPlugin = defineToolPlugin({
  id: "docwen",
  name: "DocWen",
  description: "Check and convert local documents, combine files, and split PDFs with DocWen.",
  activation: { onStartup: false },
  configSchema: docwenConfigSchema,
  tools: (tool) => defineDocWenTools(tool),
});
