/**
 * Gemini Web speaks ACP through this plugin's own adapter binary (gemini-acp),
 * which drives the gemini-bridge OpenAI-compatible endpoint. The SDK's generic
 * ACP bridge is the whole host surface: BB drives it, it drives gemini-acp.
 */
export { experimental_acpProviderBridge as experimental_providerBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";