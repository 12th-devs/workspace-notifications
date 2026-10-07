// Forward actor messages through the embedding browser's owning chrome window.
export class WorkspaceNotificationsParent extends JSWindowActorParent {
  receiveMessage(msg) {
    try {
      const browser = this.browsingContext?.top?.embedderElement;
      const win = browser?.ownerGlobal || this.browsingContext?.topChromeWindow;
      if (!win || win.closed || win.PrivateBrowsingUtils?.isWindowPrivate(win)) return;
      const bridge = win.WorkspaceNotificationsStore;
      if (!bridge) {
        console.error("[WorkspaceNotifications] parent bridge unavailable");
        return;
      }
      const data = msg.data;
      if (!data || typeof data.sourceId !== "string" || typeof data.service !== "string") return;
      if (msg.name === "WorkspaceNotifications:Snapshot") bridge.handleSnapshot(data, this.browsingContext);
      else if (msg.name === "WorkspaceNotifications:Diagnostic") bridge.logDiagnostic?.(data, this.browsingContext);
    } catch (error) {
      console.error("[WorkspaceNotifications] parent dispatch failed", error);
    }
  }
}
