import {gmailFeedURL,parseGmailAtom} from './NotificationGmail.sys.mjs';
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
      if(msg.name==='WorkspaceNotifications:ParseGmailAtom'){
        if(!bridge.canParseGmailAtom?.(data,this.browsingContext) || typeof data.xml!=='string' || data.xml.length>500000)return {error:'Unpaired or unavailable Gmail source'};
        return parseGmailAtom(data.xml,{defaultView:win},gmailFeedURL(browser.currentURI.spec));
      }
      if (msg.name === "WorkspaceNotifications:Snapshot") bridge.handleSnapshot(data, this.browsingContext);
      else if (msg.name === "WorkspaceNotifications:Diagnostic") bridge.logDiagnostic?.(data, this.browsingContext);
    } catch (error) {
      if(msg.name==='WorkspaceNotifications:ParseGmailAtom')return {error:'Invalid Gmail Atom feed'};
      console.error("[WorkspaceNotifications] parent dispatch failed", error);
    }
  }
}
