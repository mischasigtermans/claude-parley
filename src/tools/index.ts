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

// Array stores tools with erased args type. Each tool's parseArgs+handler
// pair is internally consistent; the dispatcher in server.ts calls parseArgs
// before handler so erasure here doesn't lose safety at the call boundary.
export type AnyToolDef = ToolDef<any>;

export const tools: AnyToolDef[] = [
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
