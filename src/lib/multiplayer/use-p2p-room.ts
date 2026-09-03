/**
 * React binding for P2PRoom. Identity and display name are captured once on
 * mount (useState initializers) so re-renders never tear down the mesh.
 *
 * There is one public arena, but a full-mesh WebRTC room cannot hold many
 * peers, so the arena is sharded invisibly: a newcomer whose first roster
 * already shows `capacity` other peers moves on to the next shard. Peers that
 * settled in a shard stay there even if it fills up behind them.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { P2PRoom, type PeerInfo } from "./p2p";

export interface UseP2PRoomOptions {
  room?: string;
  name?: string;
  /** Max other peers a shard takes before newcomers move on. */
  capacity?: number;
}

export interface P2PRoomHandle {
  selfId: string;
  room: string;
  peers: PeerInfo[];
  joined: boolean;
  broadcast: (data: unknown) => void;
  send: (data: unknown, peerId?: string) => void;
  onMessage: (
    fn: (from: string, data: unknown, channel: "state" | "reliable") => void,
  ) => () => void;
}

const DEFAULT_CAPACITY = 8;

function defaultRoom(): string {
  if (typeof window === "undefined") return "room-ssr";
  return `room-${window.location.hostname.split(".")[0]}`.slice(0, 64);
}

export function useP2PRoom(options: UseP2PRoomOptions = {}): P2PRoomHandle {
  const [selfId] = useState(() => `p-${Math.random().toString(36).slice(2, 10)}`);
  const base = options.room ?? defaultRoom();
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  const [shard, setShard] = useState(0);
  const room = shard > 0 ? `${base}-${shard}` : base;
  const [name] = useState(() => options.name ?? selfId);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [joined, setJoined] = useState(false);
  const roomRef = useRef<P2PRoom | null>(null);
  const settled = useRef(false);
  const listeners = useRef(
    new Set<(from: string, data: unknown, channel: "state" | "reliable") => void>(),
  );

  useEffect(() => {
    setPeers([]);
    setJoined(false);
    settled.current = false;
    const consider = (list: PeerInfo[]): boolean => {
      if (settled.current) return true;
      if (list.length >= capacity) {
        setShard((s) => s + 1);
        return false;
      }
      settled.current = true;
      return true;
    };
    const p2p = new P2PRoom({
      room,
      selfId,
      name,
      onPeersChanged: (list) => {
        if (consider(list)) setPeers(list);
      },
      onMessage: (from, data, channel) => {
        for (const fn of listeners.current) fn(from, data, channel);
      },
      onConnected: () => {
        if (consider(p2p.peerList())) setJoined(true);
      },
    });
    roomRef.current = p2p;
    void p2p.join();
    return () => {
      roomRef.current = null;
      p2p.close();
    };
  }, [room, selfId, name, capacity]);

  const broadcast = useCallback((data: unknown) => roomRef.current?.broadcast(data), []);
  const send = useCallback(
    (data: unknown, peerId?: string) => roomRef.current?.send(data, peerId),
    [],
  );
  const onMessage = useCallback(
    (fn: (from: string, data: unknown, channel: "state" | "reliable") => void) => {
      listeners.current.add(fn);
      return () => {
        listeners.current.delete(fn);
      };
    },
    [],
  );

  return { selfId, room, peers, joined, broadcast, send, onMessage };
}
