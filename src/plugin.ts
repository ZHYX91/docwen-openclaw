import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

import { docwenConfigSchema } from "./config.js";
import { defineDocWenTools } from "./tools/definitions.js";

export const docwenPlugin = defineToolPlugin({
  id: "docwen",
  name: "DocWen",
  description: "Operate DocWen through Machine Protocol v2 and verified Artifact Bundles.",
  activation: { onStartup: false },
  configSchema: docwenConfigSchema,
  tools: (tool) => defineDocWenTools(tool),
});
