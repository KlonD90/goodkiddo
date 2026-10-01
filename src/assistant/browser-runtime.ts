import { BrowserNetworkPolicy } from '../capabilities/browser/network-policy.js';
import {
  BrowserSlots,
  ReadOnlyBrowserJob,
} from '../capabilities/browser/job.js';
import { socketBrowserFactory } from '../browser-worker/client.js';

/** Explicit bootstrap injection only; construction does not connect or launch. */
export class BrowserResearchRuntime {
  private readonly slots = new BrowserSlots(1);
  private readonly factory;
  constructor(socket: string) {
    this.factory = socketBrowserFactory(socket);
  }
  open(
    chatId: string,
    taskId: string,
    signal: AbortSignal,
  ): ReadOnlyBrowserJob {
    return new ReadOnlyBrowserJob(
      this.factory,
      new BrowserNetworkPolicy([], undefined, { publicBrowsing: true }),
      signal,
      this.slots,
      { chatId, taskId },
    );
  }
}
