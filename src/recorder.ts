/**
 * Copyright 2020 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as puppeteer from 'puppeteer';
import { Readable } from 'stream';
import { existsSync, promises as fs } from 'fs';
import * as helpers from './helpers';
import * as protocol from 'devtools-protocol';
import { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js';

declare module 'puppeteer' {
  interface ElementHandle {
    _remoteObject: { objectId: string };
  }
  interface Page {
    _client: puppeteer.CDPSession;
  }
  interface CDPSession {
    send<T extends keyof ProtocolMapping.Commands>(
      method: T,
      ...paramArgs: ProtocolMapping.Commands[T]['paramsType']
    ): Promise<ProtocolMapping.Commands[T]['returnType']>;
  }
}

interface RecorderOptions {
  wsEndpoint?: string;
  saveDom?: boolean;
}

async function getBrowserInstance(options: RecorderOptions) {
  if (options && options.wsEndpoint) {
    return puppeteer.connect({ browserWSEndpoint: options.wsEndpoint });
  } else {
    return puppeteer.launch({
      headless: false,
      defaultViewport: null,
    });
  }
}

function escapeSelector(selector: string): string {
  return JSON.stringify(selector);
}

export async function isSubmitButton(
  client: puppeteer.CDPSession,
  objectId: string
): Promise<boolean> {
  const isSubmitButtonResponse = await client.send('Runtime.callFunctionOn', {
    functionDeclaration: helpers.isSubmitButton.toString(),
    objectId,
  });
  return isSubmitButtonResponse.result.value;
}

type AXNode = protocol.Protocol.Accessibility.AXNode;
type CDPSession = puppeteer.CDPSession;

// We check that a selector uniquely selects an element by querying the
// selector and checking that all found elements are in the subtree of the
// target.
async function checkUnique(
  client: CDPSession,
  ignored: AXNode[],
  name?: string,
  role?: string
) {
  const { root } = await client.send('DOM.getDocument', { depth: 0 });
  const checkName = await client.send('Accessibility.queryAXTree', {
    backendNodeId: root.backendNodeId,
    accessibleName: name,
    role: role,
  });
  const ignoredIds = new Set(ignored.map((axNode) => axNode.backendDOMNodeId));
  const checkNameMinusTargetTree = checkName.nodes.filter(
    (axNode) => !ignoredIds.has(axNode.backendDOMNodeId)
  );
  return checkNameMinusTargetTree.length < 2;
}

export async function getSelector(
  client: puppeteer.CDPSession,
  objectId: string
): Promise<string | null> {
  let currentObjectId = objectId;
  let prevName = '';
  while (currentObjectId) {
    const queryResp = await client.send('Accessibility.queryAXTree', {
      objectId: currentObjectId,
    });
    const targetNodes = queryResp.nodes;
    if (targetNodes.length === 0) break;
    const axNode = targetNodes[0];
    const name: string = axNode.name.value;
    const role: string = axNode.role.value;
    // If the name does not include the child name, we have probably reached a
    // completely different entity so we give up and pick a CSS selector.
    if (!name.includes(prevName)) break;
    prevName = name;
    const uniqueName = await checkUnique(client, targetNodes, name);
    if (name && uniqueName) {
      return `aria/${name}`;
    }
    const uniqueNameRole = await checkUnique(client, targetNodes, name, role);
    if (name && role && uniqueNameRole) {
      return `aria/${name}[role="${role}"]`;
    }
    const { result } = await client.send('Runtime.callFunctionOn', {
      functionDeclaration: helpers.getParent.toString(),
      objectId: currentObjectId,
    });
    currentObjectId = result.objectId;
  }
  const { result } = await client.send('Runtime.callFunctionOn', {
    functionDeclaration: helpers.cssPath.toString(),
    objectId,
  });
  return result.value;
}

export default async (
  url: string,
  options: RecorderOptions = {}
): Promise<Readable> => {
  if (!url.startsWith('http')) {
    url = 'https://' + url;
  }

  const output = new Readable({
    read(size) {},
  });
  output.setEncoding('utf8');
  const browser = await getBrowserInstance(options);
  const page = await browser.pages().then((pages) => pages[0]);
  const client = page._client;

  let identation = 0;
  const addLineToPuppeteerScript = (line: string) => {
    const data = '  '.repeat(identation) + line;
    output.push(data + '\n');
  };

  const saveDomIfNeeded = async () => {
    if (!options.saveDom) {
      return;
    }
    const { root } = await client.send('DOM.getDocument', {
      depth: -1,
      pierce: true,
    });
    const { outerHTML } = await client.send('DOM.getOuterHTML', {
      nodeId: root.nodeId,
    });
    const timestamp = Math.floor(Date.now() / 1000);
    let fileName = `${timestamp}.html`;
    let suffix = 1;
    while (existsSync(fileName)) {
      fileName = `${timestamp}_${suffix}.html`;
      suffix++;
    }
    await fs.writeFile(fileName, outerHTML);
    addLineToPuppeteerScript(`// saved DOM to ${fileName}`);
  };
  page.on('domcontentloaded', async () => {
    await client.send('Debugger.enable', {});
    await client.send('DOMDebugger.setEventListenerBreakpoint', {
      eventName: 'click',
    });
    await client.send('DOMDebugger.setEventListenerBreakpoint', {
      eventName: 'change',
    });
    await client.send('DOMDebugger.setEventListenerBreakpoint', {
      eventName: 'submit',
    });
    // The heuristics we have for recording scrolling are quite fragile and
    // does not capture a reasonable set of scroll actions so we have decided
    // to disable it fow now
    /*
     await client.send('DOMDebugger.setEventListenerBreakpoint', {
      eventName: 'scroll',
     });
    */
  });

  const findTargetId = async (localFrame, interestingClassNames: string[]) => {
    const event = localFrame.find((prop) =>
      interestingClassNames.includes(prop.value.className)
    );
    const eventProperties = await client.send('Runtime.getProperties', {
      objectId: event.value.objectId as string,
    });
    const target = eventProperties.result.find(
      (prop) => prop.name === 'target'
    );
    return target.value.objectId;
  };

  const skip = async () => {
    await client.send('Debugger.resume', { terminateOnResume: false });
  };
  const resume = async () => {
    await client.send('Debugger.setSkipAllPauses', { skip: true });
    await skip();
    await client.send('Debugger.setSkipAllPauses', { skip: false });
  };

  const handleClickEvent = async (localFrame) => {
    const targetId = await findTargetId(localFrame, [
      'MouseEvent',
      'PointerEvent',
    ]);
    // Let submit handle this case if the click is on a submit button.
    if (await isSubmitButton(client, targetId)) {
      return skip();
    }
    const selector = await getSelector(client, targetId);
    if (selector) {
      await saveDomIfNeeded();
      addLineToPuppeteerScript(`await click(${escapeSelector(selector)});`);
    } else {
      console.log(`failed to generate selector`);
    }
    await resume();
  };

  const handleSubmitEvent = async (localFrame) => {
    const targetId = await findTargetId(localFrame, ['SubmitEvent']);
    const selector = await getSelector(client, targetId);
    if (selector) {
      addLineToPuppeteerScript(`await submit(${escapeSelector(selector)});`);
    } else {
      console.log(`failed to generate selector`);
    }
    await resume();
  };

  const handleChangeEvent = async (localFrame) => {
    const targetId = await findTargetId(localFrame, ['Event']);
    const targetValue = await client.send('Runtime.callFunctionOn', {
      functionDeclaration: 'function() { return this.value }',
      objectId: targetId,
    });
    const value = targetValue.result.value;
    const selector = await getSelector(client, targetId);
    addLineToPuppeteerScript(
      `await type(${escapeSelector(selector)}, ${escapeSelector(value)});`
    );
    await resume();
  };

  let scrollTimeout = null;
  const handleScrollEvent = async () => {
    if (scrollTimeout) return resume();
    const prevScrollHeightResp = await client.send('Runtime.evaluate', {
      expression: 'document.scrollingElement.scrollHeight',
    });
    const prevScrollHeight = prevScrollHeightResp.result.value;
    scrollTimeout = new Promise(function (resolve) {
      setTimeout(async () => {
        const currentScrollHeightResp = await client.send('Runtime.evaluate', {
          expression: 'document.scrollingElement.scrollHeight',
        });
        const currentScrollHeight = currentScrollHeightResp.result.value;
        if (currentScrollHeight > prevScrollHeight) {
          addLineToPuppeteerScript(`await scrollToBottom();`);
        }
        scrollTimeout = null;
        resolve();
      }, 1000);
    });
    await resume();
  };

  client.on(
    'Debugger.paused',
    async function (pausedEvent: protocol.Protocol.Debugger.PausedEvent) {
      const eventName = pausedEvent.data.eventName;
      const localFrame = pausedEvent.callFrames[0].scopeChain[0];
      const { result } = await client.send('Runtime.getProperties', {
        objectId: localFrame.object.objectId,
      });
      if (eventName === 'listener:click') {
        await handleClickEvent(result);
      } else if (eventName === 'listener:submit') {
        await handleSubmitEvent(result);
      } else if (eventName === 'listener:change') {
        await handleChangeEvent(result);
      } else if (eventName === 'listener:scroll') {
        await handleScrollEvent();
      } else {
        await skip();
      }
    }
  );

  page.evaluateOnNewDocument(() => {
    window.addEventListener('change', (event) => {}, true);
    window.addEventListener('click', (event) => {}, true);
    window.addEventListener('submit', (event) => {}, true);
    window.addEventListener('scroll', () => {}, true);
  });

  // Setup puppeteer
  addLineToPuppeteerScript(
    `const {open, click, type, submit, expect, scrollToBottom} = require('@puppeteer/recorder');`
  );
  addLineToPuppeteerScript(`open('${url}', {}, async (page) => {`);
  identation += 1;

  // Open the initial page
  await page.goto(url);

  // Add expectations for mainframe navigations
  page.on('framenavigated', async (frame: puppeteer.Frame) => {
    if (frame.parentFrame()) return;
    addLineToPuppeteerScript(
      `expect(page.url()).resolves.toBe(${escapeSelector(frame.url())});`
    );
  });

  async function close() {
    identation -= 1;
    addLineToPuppeteerScript(`});`);
    output.push(null);

    // In case we started the browser instance
    if (!options.wsEndpoint) {
      // Close it
      await browser.close();
    }
  }

  // Finish the puppeteer script when the page is closed
  page.on('close', close);
  // Or if the user stops the script
  process.on('SIGINT', async () => {
    await close();
    process.exit();
  });

  return output;
};
