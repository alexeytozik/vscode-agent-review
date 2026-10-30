'use strict';
// Older Electron builds expose the webview as a CDP target without adding it
// to Playwright's frame registry. Keep native input on the real workbench.
module.exports = async (browser, page) => {
  const outer = page.locator('iframe[src*="extensionId=alexeytozik.agent-review"]').first();
  const webFrame = page.frames().find(frame => frame !== page.mainFrame());
  if (webFrame) {
    const holder = page.frameLocator('iframe[src*="extensionId=alexeytozik.agent-review"]').locator('#active-frame');
    return { outer, holder, session: await page.context().newCDPSession(webFrame), element: async selector => (await holder.evaluateHandle((frame, selector) => frame.contentDocument.querySelector(selector), selector)).asElement() };
  }
  const root = await browser.newBrowserCDPSession(), target = (await root.send('Target.getTargets')).targetInfos.find(target => target.type === 'iframe' && target.url.includes('extensionId=alexeytozik.agent-review'));
  if (!target) throw new Error('The isolated review webview target is missing.');
  const { sessionId } = await root.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  let sequence = 0; const pending = new Map();
  root.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message), request = pending.get(message.id); if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer); if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('Webview protocol request timed out: ' + method)); }, 30000); timer.unref();
    pending.set(id, { resolve, reject, timer });
    root.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(error => { pending.delete(id); clearTimeout(timer); reject(error); });
  });
  const holder = { evaluate: async (callback, arg) => {
    const result = await send('Runtime.evaluate', { expression: '(' + callback.toString() + ')(document.getElementById("active-frame"),' + (JSON.stringify(arg) ?? 'undefined') + ')', returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  } };
  const input = await page.context().newCDPSession(page);
  const element = async selector => ({
    focus: () => holder.evaluate((frame, selector) => frame.contentDocument.querySelector(selector).focus(), selector),
    click: async () => {
      const local = await holder.evaluate((frame, selector) => {
        const element = frame.contentDocument.querySelector(selector); if (!element || element.disabled) throw new Error('Review control is unavailable.');
        const bounds = element.getBoundingClientRect(), offset = frame.getBoundingClientRect(); return { x: offset.left + (bounds.left + bounds.right) / 2, y: offset.top + (bounds.top + bounds.bottom) / 2 };
      }, selector), bounds = await outer.boundingBox(); if (!bounds) throw new Error('Review surface is not visible.');
      const position = { x: bounds.x + local.x, y: bounds.y + local.y };
      await input.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
      await input.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...position });
      await input.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...position });
    }
  });
  return { outer, holder, element, session: { send } };
};
