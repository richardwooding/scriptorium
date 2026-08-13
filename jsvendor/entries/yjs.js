import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness.js";
window.Y = Y;
window.YProto = { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates };
