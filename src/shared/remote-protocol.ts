import { z } from 'zod';

// Wire protocol between the phone remote and NOVA. Shared by both ends so
// validation and MAC construction can never drift apart.

export const REMOTE_PROTOCOL_VERSION = 1;

export const MAC_LABELS = {
  pairClient: 'nova-pair-v1',
  pairServer: 'nova-pair-server-v1',
  deviceSecret: 'nova-device-secret-v1',
  auth: 'nova-auth-v1',
  session: 'nova-session-v1',
} as const;

export const pairClientMessage = (clientPublicKey: string) => `${MAC_LABELS.pairClient}|${clientPublicKey}`;
export const pairServerMessage = (serverPublicKey: string, clientPublicKey: string, deviceId: string) =>
  `${MAC_LABELS.pairServer}|${serverPublicKey}|${clientPublicKey}|${deviceId}`;
export const deviceSecretInfo = (deviceId: string) => `${MAC_LABELS.deviceSecret}|${deviceId}`;
export const authMessage = (nonce: string, deviceId: string) => `${MAC_LABELS.auth}|${nonce}|${deviceId}`;
export const sessionKeyMessage = (nonce: string) => `${MAC_LABELS.session}|${nonce}`;
export const commandMessage = (seq: number, body: string) => `${seq}|${body}`;

const b64url = z.string().regex(/^[A-Za-z0-9_-]+$/).max(200);

export const pairRequestSchema = z
  .object({
    v: z.literal(REMOTE_PROTOCOL_VERSION),
    clientPublicKey: b64url.length(43), // 32 bytes base64url without padding
    deviceName: z.string().trim().min(1).max(40).regex(/^[^<>\u0000-\u001f]+$/),
    proof: b64url.length(43), // HMAC-SHA256
  })
  .strict();
export type PairRequest = z.infer<typeof pairRequestSchema>;

export interface PairResponse {
  deviceId: string;
  serverPublicKey: string;
  serverProof: string;
  tvName: string;
}

export const NAV_KEYS = ['up', 'down', 'left', 'right', 'select', 'back', 'home', 'menu', 'info'] as const;
export const PICTURE_MODE_VALUES = ['auto', 'standard', 'cinema', 'vivid', 'gaming', 'custom'] as const;

export const remoteCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('key'), key: z.enum(NAV_KEYS) }).strict(),
  z.object({ type: z.literal('playback'), action: z.enum(['toggle', 'play', 'pause', 'stop', 'next', 'previous']) }).strict(),
  z
    .object({
      type: z.literal('seek'),
      mode: z.enum(['relative', 'absolute', 'percent']),
      value: z.number().finite().min(-3600).max(86400),
    })
    .strict(),
  z
    .object({
      type: z.literal('volume'),
      action: z.enum(['up', 'down', 'set', 'mute', 'unmute', 'toggleMute']),
      value: z.number().int().min(0).max(130).optional(),
    })
    .strict(),
  z.object({ type: z.literal('text'), text: z.string().max(200).regex(/^[^\u0000-\u001f]*$/), submit: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('backspace') }).strict(),
  z.object({ type: z.literal('search'), query: z.string().trim().max(120).regex(/^[^\u0000-\u001f]*$/) }).strict(),
  z.object({ type: z.literal('pictureMode'), mode: z.enum(PICTURE_MODE_VALUES) }).strict(),
  z.object({ type: z.literal('track'), kind: z.enum(['audio', 'sub']), id: z.union([z.number().int().min(0).max(10000), z.literal('off')]) }).strict(),
  z.object({ type: z.literal('getState') }).strict(),
]);
export type RemoteCommand = z.infer<typeof remoteCommandSchema>;

/** Client → server envelope after authentication. */
export const commandEnvelopeSchema = z
  .object({
    t: z.literal('cmd'),
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    body: z.string().max(1024),
    mac: b64url.length(43),
  })
  .strict();

export const authEnvelopeSchema = z
  .object({
    t: z.literal('auth'),
    deviceId: z.string().regex(/^[a-f0-9]{32}$/),
    mac: b64url.length(43),
  })
  .strict();

export interface RemoteNowPlaying {
  tvName: string;
  status: string;
  title: string | null;
  kind: string | null;
  position: number;
  duration: number;
  paused: boolean;
  volume: number;
  muted: boolean;
  pictureMode: string;
  audioTracks: Array<{ id: number; label: string; selected: boolean }>;
  subtitleTracks: Array<{ id: number; label: string; selected: boolean }>;
  screen: string;
}

export type ServerMessage =
  | { t: 'challenge'; v: number; nonce: string; tvName: string }
  | { t: 'ready'; state: RemoteNowPlaying }
  | { t: 'state'; state: RemoteNowPlaying }
  | { t: 'ack'; seq: number; ok: boolean; error?: string }
  | { t: 'error'; error: string }
  | { t: 'revoked' };
