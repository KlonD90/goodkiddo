import { startBrowserBroker } from './broker.js';

const image = process.argv[2];
if (!/^localhost\/goodkiddo-browser:[a-f0-9]{12}$/.test(image || ''))
  throw new Error('A pinned local browser image is required.');
startBrowserBroker(image);
