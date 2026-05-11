import type { ToolDef } from './types.js';
import { parleyAdd } from './parleyAdd.js';
import { parleyAsk } from './parleyAsk.js';
import { parleyClean } from './parleyClean.js';
import { parleyDiscover } from './parleyDiscover.js';
import { parleyListen } from './parleyListen.js';
import { parleyLog } from './parleyLog.js';
import { parleyPeers } from './parleyPeers.js';
import { parleyReceiveNext } from './parleyReceiveNext.js';
import { parleyRemove } from './parleyRemove.js';
import { parleyReset } from './parleyReset.js';
import { parleyRespond } from './parleyRespond.js';

export const tools: ToolDef[] = [
  parleyAdd,
  parleyAsk,
  parleyClean,
  parleyDiscover,
  parleyListen,
  parleyLog,
  parleyPeers,
  parleyReceiveNext,
  parleyRemove,
  parleyReset,
  parleyRespond,
];
