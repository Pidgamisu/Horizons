/**
 * activeClient — a tiny indirection over "the client the UI is currently
 * driving". Normally that's the networked `gameClient`; during the interactive
 * tutorial it's a `TutorialClient` that replays a scripted scenario. Both expose
 * the same surface (playCard/voidCard/passPriority/choose/concede + events), so
 * call sites that don't already receive a client (e.g. the on-card Play/Void
 * buttons in CardShapeUtil) can reach the live one through getClient().
 */

import { gameClient } from './client.js'

let active = gameClient

export function getClient() {
  return active
}

export function setClient(client) {
  active = client
  window.gameClient = client // keep the debug handle pointing at the live client
}
