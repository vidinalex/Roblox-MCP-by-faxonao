import { randomUUID } from "node:crypto";
import { PlayMode, PlayState, StudioSession } from "../domain/types.js";

function nowIso(): string {
  return new Date().toISOString();
}

export interface HelloPayload {
  clientId: string;
  placeId: string;
  placeName: string;
  pluginVersion: string;
  editorApiAvailable?: boolean;
  base64Transport?: boolean;
  playApiAvailable?: boolean;
  logCaptureAvailable?: boolean;
}

export class SessionRegistry {
  private activeSession: StudioSession | null = null;

  registerHello(payload: HelloPayload): { session: StudioSession; replacedPrevious: boolean } {
    const now = nowIso();
    if (this.activeSession && this.activeSession.clientId === payload.clientId) {
      this.activeSession.placeId = payload.placeId;
      this.activeSession.placeName = payload.placeName;
      this.activeSession.pluginVersion = payload.pluginVersion;
      this.activeSession.editorApiAvailable = payload.editorApiAvailable ?? null;
      this.activeSession.base64Transport = payload.base64Transport === true;
      this.activeSession.playApiAvailable = payload.playApiAvailable ?? null;
      this.activeSession.logCaptureAvailable = payload.logCaptureAvailable ?? null;
      this.activeSession.lastSeenAt = now;
      return { session: this.activeSession, replacedPrevious: false };
    }

    const replacedPrevious = this.activeSession !== null;
    this.activeSession = {
      sessionId: randomUUID(),
      clientId: payload.clientId,
      placeId: payload.placeId,
      placeName: payload.placeName,
      pluginVersion: payload.pluginVersion,
      editorApiAvailable: payload.editorApiAvailable ?? null,
      base64Transport: payload.base64Transport === true,
      playApiAvailable: payload.playApiAvailable ?? null,
      logCaptureAvailable: payload.logCaptureAvailable ?? null,
      playState: "stopped",
      playMode: null,
      playSessionId: null,
      connectedAt: now,
      lastSeenAt: now,
      lastPollAt: null
    };
    return { session: this.activeSession, replacedPrevious };
  }

  touchPoll(sessionId: string): StudioSession | null {
    if (!this.activeSession || this.activeSession.sessionId !== sessionId) {
      return null;
    }
    this.activeSession.lastPollAt = nowIso();
    this.activeSession.lastSeenAt = this.activeSession.lastPollAt;
    return this.activeSession;
  }

  resolve(sessionId: string): StudioSession | null {
    if (!this.activeSession || this.activeSession.sessionId !== sessionId) {
      return null;
    }
    this.activeSession.lastSeenAt = nowIso();
    return this.activeSession;
  }

  updatePlayState(
    sessionId: string,
    playState: PlayState,
    playMode: PlayMode | null,
    playSessionId: string | null
  ): StudioSession | null {
    const session = this.resolve(sessionId);
    if (!session) {
      return null;
    }
    session.playState = playState;
    session.playMode = playMode;
    session.playSessionId = playSessionId;
    session.lastSeenAt = nowIso();
    return session;
  }

  active(): StudioSession | null {
    return this.activeSession;
  }
}
