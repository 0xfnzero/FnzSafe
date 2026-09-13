export interface NativeDappVisibilityInput {
  workspaceVisible: boolean;
  connectRequestOpen: boolean;
  signRequestOpen: boolean;
  overlayOpen: boolean;
  webviewOpen: boolean;
  hasBounds: boolean;
}

export function shouldShowNativeDappWebview(input: NativeDappVisibilityInput): boolean {
  return input.workspaceVisible
    && !input.connectRequestOpen
    && !input.signRequestOpen
    && !input.overlayOpen
    && input.webviewOpen
    && input.hasBounds;
}
