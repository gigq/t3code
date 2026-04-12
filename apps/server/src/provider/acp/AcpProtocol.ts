import type * as acp from "@agentclientprotocol/sdk";

export type AcpSdk = typeof acp;
export type AcpClientConnection = acp.ClientSideConnection;
export type AcpClient = acp.Client;
export type AcpAgentCapabilities = acp.AgentCapabilities | undefined;
export type AcpInitializeResponse = acp.InitializeResponse;
export type AcpSessionNotification = acp.SessionNotification;
export type AcpSessionUpdate = acp.SessionUpdate;
export type AcpPromptRequest = acp.PromptRequest;
export type AcpPromptResponse = acp.PromptResponse;
export type AcpRequestPermissionRequest = acp.RequestPermissionRequest;
export type AcpRequestPermissionResponse = acp.RequestPermissionResponse;
export type AcpToolCall = acp.ToolCall;
export type AcpToolCallUpdate = acp.ToolCallUpdate;
export type AcpContentBlock = acp.ContentBlock;
export type AcpModelInfo = acp.ModelInfo;
export type AcpNewSessionResponse = acp.NewSessionResponse;
export type AcpLoadSessionResponse = acp.LoadSessionResponse;

export function hasLoadSessionCapability(capabilities: AcpAgentCapabilities): boolean {
  return capabilities?.loadSession === true;
}
