import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Cloud, Plus, Swords, Trash2, Trophy, Users } from "lucide-react";

import { isSupabaseConfigured, joinRoom, saveRoom } from "./supabase";
import type { AppData, Match, Player } from "./types";

type Payout = {
  from: string;
  to: string;
  amount: number;
};

const STORAGE_KEY = "doekoe.advanced.v1";
const ROOM_SESSION_KEY = "doekoe.activeRoom.v1";
const MIN_PAYOUT = 10;
const EMPTY_DATA: AppData = { players: [], matches: [] };

const currency = new Intl.NumberFormat("nl-NL", {
  style: "currency",
  currency: "EUR",
});

function createId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function toggleSelected(list: string[], id: string) {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

function slugifyRoomName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

async function hashPassword(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function calculateBalances(players: Player[], matches: Match[]) {
  const balances = new Map(players.map((player) => [player.id, 0]));
  const pairTotals = new Map<string, Payout>();

  for (const match of matches) {
    for (const winnerId of match.winnerIds) {
      const payers = match.receiveFromByWinner[winnerId]?.length ? match.receiveFromByWinner[winnerId] : match.loserIds;

      for (const payerId of payers) {
        if (payerId === winnerId || !balances.has(payerId)) continue;

        balances.set(winnerId, roundMoney((balances.get(winnerId) ?? 0) + match.stake));
        balances.set(payerId, roundMoney((balances.get(payerId) ?? 0) - match.stake));

        const key = `${payerId}->${winnerId}`;
        const existing = pairTotals.get(key);
        pairTotals.set(key, {
          from: payerId,
          to: winnerId,
          amount: roundMoney((existing?.amount ?? 0) + match.stake),
        });
      }
    }
  }

  const payouts = [...pairTotals.values()].sort((a, b) => b.amount - a.amount);

  return {
    balances,
    obliged: payouts.filter((payout) => payout.amount >= MIN_PAYOUT),
    optional: payouts.filter((payout) => payout.amount > 0 && payout.amount < MIN_PAYOUT),
  };
}

function App() {
  const [data, setData] = useState<AppData>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? (JSON.parse(saved) as AppData) : EMPTY_DATA;
    } catch {
      return EMPTY_DATA;
    }
  });
  const [roomName, setRoomName] = useState("");
  const [roomPassword, setRoomPassword] = useState("");
  const [activeRoom, setActiveRoom] = useState<{ slug: string; passwordHash: string } | null>(() => {
    try {
      const saved = localStorage.getItem(ROOM_SESSION_KEY);
      return saved ? (JSON.parse(saved) as { slug: string; passwordHash: string }) : null;
    } catch {
      return null;
    }
  });
  const [roomError, setRoomError] = useState("");
  const [syncStatus, setSyncStatus] = useState(isSupabaseConfigured ? "Local until you join a room" : "Add Supabase env vars to enable shared rooms");
  const [isJoiningRoom, setIsJoiningRoom] = useState(false);
  const skipNextSaveRef = useRef(false);
  const [newPlayerName, setNewPlayerName] = useState("");
  const [stake, setStake] = useState("10");
  const [winnerIds, setWinnerIds] = useState<string[]>([]);
  const [loserIds, setLoserIds] = useState<string[]>([]);
  const [receiveFromByWinner, setReceiveFromByWinner] = useState<Record<string, string[]>>({});

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [data]);

  useEffect(() => {
    if (!activeRoom) {
      localStorage.removeItem(ROOM_SESSION_KEY);
      return;
    }

    localStorage.setItem(ROOM_SESSION_KEY, JSON.stringify(activeRoom));
  }, [activeRoom]);

  useEffect(() => {
    if (!activeRoom || !isSupabaseConfigured) return;

    let cancelled = false;
    const room = activeRoom;

    async function loadActiveRoom() {
      try {
        setSyncStatus("Loading shared room...");
        const remoteData = await joinRoom(room.slug, room.passwordHash);
        if (cancelled) return;
        skipNextSaveRef.current = true;
        setData(remoteData ?? EMPTY_DATA);
        setSyncStatus("Shared room connected");
      } catch (error) {
        if (cancelled) return;
        setRoomError(error instanceof Error ? error.message : "Could not load room");
        setSyncStatus("Room sync failed");
      }
    }

    void loadActiveRoom();
    const intervalId = window.setInterval(loadActiveRoom, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeRoom]);

  useEffect(() => {
    if (!activeRoom || !isSupabaseConfigured) return;

    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }

    const timeoutId = window.setTimeout(async () => {
      try {
        setSyncStatus("Saving shared room...");
        await saveRoom(activeRoom.slug, activeRoom.passwordHash, data);
        setSyncStatus("Saved to shared room");
      } catch (error) {
        setRoomError(error instanceof Error ? error.message : "Could not save room");
        setSyncStatus("Room save failed");
      }
    }, 450);

    return () => window.clearTimeout(timeoutId);
  }, [activeRoom, data]);

  const playerNameById = useMemo(() => new Map(data.players.map((player) => [player.id, player.name])), [data.players]);
  const { balances, obliged } = useMemo(() => calculateBalances(data.players, data.matches), [data.players, data.matches]);
  const totalInPlay = data.matches.reduce((sum, match) => {
    const matchPayers = match.winnerIds.reduce((count, winnerId) => count + (match.receiveFromByWinner[winnerId]?.length || match.loserIds.length), 0);
    return roundMoney(sum + match.stake * matchPayers);
  }, 0);
  const stakeAmount = Number(stake);
  const canAddMatch = stakeAmount > 0 && winnerIds.length > 0 && loserIds.length > 0;
  const roomLocked = isSupabaseConfigured && !activeRoom;

  async function connectRoom(event: FormEvent) {
    event.preventDefault();
    setRoomError("");

    if (!isSupabaseConfigured) {
      setRoomError("Supabase is not configured yet. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY first.");
      return;
    }

    const slug = slugifyRoomName(roomName);
    if (!slug || !roomPassword) {
      setRoomError("Enter a room name and password.");
      return;
    }

    try {
      setIsJoiningRoom(true);
      setSyncStatus("Joining shared room...");
      const passwordHash = await hashPassword(`${slug}:${roomPassword}`);
      const remoteData = await joinRoom(slug, passwordHash);
      skipNextSaveRef.current = true;
      setData(remoteData ?? EMPTY_DATA);
      setActiveRoom({ slug, passwordHash });
      setRoomName("");
      setRoomPassword("");
      setSyncStatus("Shared room connected");
    } catch (error) {
      setRoomError(error instanceof Error ? error.message : "Could not join room");
      setSyncStatus("Room join failed");
    } finally {
      setIsJoiningRoom(false);
    }
  }

  function leaveRoom() {
    setActiveRoom(null);
    setRoomError("");
    setSyncStatus(isSupabaseConfigured ? "Local until you join a room" : "Add Supabase env vars to enable shared rooms");
  }

  function addPlayer(event: FormEvent) {
    event.preventDefault();
    const name = newPlayerName.trim();
    if (!name) return;

    setData((current) => ({ ...current, players: [...current.players, { id: createId(), name }] }));
    setNewPlayerName("");
  }

  function removePlayer(id: string) {
    setData((current) => ({
      players: current.players.filter((player) => player.id !== id),
      matches: current.matches
        .map((match) => ({
          ...match,
          winnerIds: match.winnerIds.filter((winnerId) => winnerId !== id),
          loserIds: match.loserIds.filter((loserId) => loserId !== id),
          receiveFromByWinner: Object.fromEntries(
            Object.entries(match.receiveFromByWinner)
              .filter(([winnerId]) => winnerId !== id)
              .map(([winnerId, payerIds]) => [winnerId, payerIds.filter((payerId) => payerId !== id)]),
          ),
        }))
        .filter((match) => match.winnerIds.length > 0 && match.loserIds.length > 0),
    }));
    setWinnerIds((current) => current.filter((playerId) => playerId !== id));
    setLoserIds((current) => current.filter((playerId) => playerId !== id));
    setReceiveFromByWinner((current) =>
      Object.fromEntries(
        Object.entries(current)
          .filter(([winnerId]) => winnerId !== id)
          .map(([winnerId, payerIds]) => [winnerId, payerIds.filter((payerId) => payerId !== id)]),
      ),
    );
  }

  function updatePlayer(id: string, name: string) {
    setData((current) => ({ ...current, players: current.players.map((player) => (player.id === id ? { ...player, name } : player)) }));
  }

  function toggleWinner(id: string) {
    setWinnerIds((current) => toggleSelected(current, id));
    setLoserIds((current) => current.filter((playerId) => playerId !== id));
  }

  function toggleLoser(id: string) {
    setLoserIds((current) => toggleSelected(current, id));
    setWinnerIds((current) => current.filter((playerId) => playerId !== id));
  }

  function toggleReceiverPayer(winnerId: string, payerId: string) {
    setReceiveFromByWinner((current) => ({
      ...current,
      [winnerId]: toggleSelected(current[winnerId] ?? [], payerId),
    }));
  }

  function addMatch(event: FormEvent) {
    event.preventDefault();
    if (!canAddMatch) return;

    const cleanedReceiveMap = Object.fromEntries(
      winnerIds.map((winnerId) => {
        const chosenPayers = receiveFromByWinner[winnerId]?.filter((payerId) => loserIds.includes(payerId)) ?? [];
        return [winnerId, chosenPayers.length ? chosenPayers : loserIds];
      }),
    );

    setData((current) => ({
      ...current,
      matches: [
        {
          id: createId(),
          createdAt: Date.now(),
          stake: roundMoney(stakeAmount),
          winnerIds,
          loserIds,
          receiveFromByWinner: cleanedReceiveMap,
        },
        ...current.matches,
      ],
    }));
    setWinnerIds([]);
    setLoserIds([]);
    setReceiveFromByWinner({});
  }

  function deleteMatch(id: string) {
    setData((current) => ({ ...current, matches: current.matches.filter((match) => match.id !== id) }));
  }

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Doekoe manager</p>
          <h1>2v2/3v3s.</h1>
          <p className="hero-copy">
            Add a match, choose winners and losers, then choose who each winner receives from. Every selected payer owes the stake to that winner. Payouts from {currency.format(MIN_PAYOUT)} are obliged.
          </p>
        </div>
        <div className="hero-card">
          {roomLocked ? (
            <>
              <span>Status</span>
              <strong>Locked</strong>
              <span>Enter a room name and password to view or edit data.</span>
            </>
          ) : (
            <>
              <span>Total in play</span>
              <strong>{currency.format(totalInPlay)}</strong>
              <span>Matches tracked</span>
              <strong>{data.matches.length}</strong>
            </>
          )}
        </div>
      </section>

      <section className="panel room-panel">
        <div>
          <p className="eyebrow">Shared room</p>
          <h2>{activeRoom ? activeRoom.slug : "Join with password"}</h2>
          <p className="helper-text">{syncStatus}</p>
          {roomError && <p className="error-text">{roomError}</p>}
        </div>

        {activeRoom ? (
          <button className="secondary-button" type="button" onClick={leaveRoom}>
            <Cloud size={18} /> Leave room
          </button>
        ) : (
          <form className="room-form" onSubmit={connectRoom}>
            <input value={roomName} onChange={(event) => setRoomName(event.target.value)} placeholder="Room name, e.g. friday-games" />
            <input value={roomPassword} onChange={(event) => setRoomPassword(event.target.value)} placeholder="Room password" type="password" />
            <button type="submit" disabled={isJoiningRoom}>
              <Cloud size={18} /> {isJoiningRoom ? "Joining" : "Join"}
            </button>
          </form>
        )}
      </section>

      {roomLocked ? (
        <section className="panel locked-panel">
          <p className="eyebrow">Locked</p>
          <h2>Join a shared room first</h2>
          <p className="helper-text">Players, matches, payouts, and editing controls are hidden until the correct room password is entered.</p>
        </section>
      ) : (
        <>
      <section className="panel dashboard-panel">
        <div className="panel-heading dashboard-heading">
          <div>
            <p className="eyebrow">Dashboard</p>
            <h2>Who pays who</h2>
          </div>
          <span className="status balanced">{obliged.length} obliged</span>
        </div>

        <div className="dashboard-list">
          {obliged.length === 0 ? (
            <div className="empty-state compact-empty">No obliged payments yet. Pair totals start counting from {currency.format(MIN_PAYOUT)}.</div>
          ) : (
            obliged.slice(0, 6).map((payout) => (
              <article className="dashboard-payment" key={`dashboard-${payout.from}-${payout.to}`}>
                <div>
                  <strong>{playerNameById.get(payout.from)}</strong>
                  <span>pays {playerNameById.get(payout.to)}</span>
                </div>
                <strong>{currency.format(payout.amount)}</strong>
              </article>
            ))
          )}
        </div>

        {obliged.length > 6 && <p className="small-print">Showing top 6 payments.</p>}
      </section>

      <section className="grid advanced-grid">
        <div className="left-stack">
          <section className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Players</p>
                <h2>Squad</h2>
              </div>
              <div className="player-count">
                <Users size={17} />
                {data.players.length}
              </div>
            </div>

            <form className="add-player" onSubmit={addPlayer}>
              <input value={newPlayerName} onChange={(event) => setNewPlayerName(event.target.value)} placeholder="Player name" />
              <button type="submit">
                <Plus size={18} /> Add
              </button>
            </form>

            <div className="players-list compact-list">
              {data.players.length === 0 ? (
                <div className="empty-state">Add your friends before creating a match.</div>
              ) : (
                data.players.map((player) => {
                  const balance = balances.get(player.id) ?? 0;
                  return (
                    <article className="player-row compact-row" key={player.id}>
                      <input className="name-input" value={player.name} onChange={(event) => updatePlayer(player.id, event.target.value)} aria-label="Player name" />
                      <strong className={balance >= 0 ? "balance positive" : "balance negative"}>{currency.format(balance)}</strong>
                      <button className="icon-button" type="button" onClick={() => removePlayer(player.id)} aria-label={`Remove ${player.name}`}>
                        <Trash2 size={18} />
                      </button>
                    </article>
                  );
                })
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Match</p>
                <h2>Advanced mode</h2>
              </div>
              <div className="player-count">
                <Swords size={17} />
                {winnerIds.length}v{loserIds.length}
              </div>
            </div>

            <form onSubmit={addMatch}>
              <label className="field-label" htmlFor="stake">
                Stake per payer to winner
              </label>
              <div className="money-input-wrap stake-field">
                <span>EUR</span>
                <input id="stake" className="money-input" type="number" min="0" step="0.01" value={stake} onChange={(event) => setStake(event.target.value)} />
              </div>

              <div className="pick-columns">
                <div>
                  <p className="field-label">Winners</p>
                  <div className="chip-grid">
                    {data.players.map((player) => (
                      <button className={winnerIds.includes(player.id) ? "chip selected" : "chip"} key={player.id} type="button" onClick={() => toggleWinner(player.id)}>
                        <Trophy size={15} /> {player.name}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="field-label">Losers</p>
                  <div className="chip-grid">
                    {data.players.map((player) => (
                      <button className={loserIds.includes(player.id) ? "chip selected" : "chip"} key={player.id} type="button" onClick={() => toggleLoser(player.id)}>
                        {player.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {winnerIds.length > 0 && loserIds.length > 0 && (
                <div className="receive-panel">
                  <p className="field-label">Who does each winner receive from?</p>
                  <p className="helper-text">Leave empty to receive from all losers. Select specific losers if the payout was split differently.</p>
                  {winnerIds.map((winnerId) => (
                    <div className="receiver-row" key={winnerId}>
                      <strong>{playerNameById.get(winnerId)}</strong>
                      <div className="chip-grid small-chips">
                        {loserIds.map((loserId) => (
                          <button
                            className={(receiveFromByWinner[winnerId]?.includes(loserId) ?? false) ? "chip selected" : "chip"}
                            key={loserId}
                            type="button"
                            onClick={() => toggleReceiverPayer(winnerId, loserId)}
                          >
                            {playerNameById.get(loserId)}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <button className="full-button" type="submit" disabled={!canAddMatch}>
                <Plus size={18} /> Add match
              </button>
            </form>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">History</p>
                <h2>Matches</h2>
              </div>
            </div>

            <div className="match-list">
              {data.matches.length === 0 ? (
                <div className="empty-state">No matches yet. Add a result to calculate payouts.</div>
              ) : (
                data.matches.map((match) => (
                  <article className="match-row" key={match.id}>
                    <div>
                      <strong>{match.winnerIds.map((id) => playerNameById.get(id)).join(", ")}</strong>
                      <span>beat {match.loserIds.map((id) => playerNameById.get(id)).join(", ")}</span>
                      <small>{currency.format(match.stake)} per payer-to-winner</small>
                    </div>
                    <button className="icon-button" type="button" onClick={() => deleteMatch(match.id)} aria-label="Delete match">
                      <Trash2 size={18} />
                    </button>
                  </article>
                ))
              )}
            </div>
          </section>
        </div>

      </section>
        </>
      )}
    </main>
  );
}

export default App;
