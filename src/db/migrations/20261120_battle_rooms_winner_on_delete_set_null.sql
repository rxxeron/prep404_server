-- Ensure deleting a user account does not fail on battle_rooms.winner_id FK
ALTER TABLE public.battle_rooms
  DROP CONSTRAINT IF EXISTS battle_rooms_winner_id_fkey;

ALTER TABLE public.battle_rooms
  ADD CONSTRAINT battle_rooms_winner_id_fkey
  FOREIGN KEY (winner_id)
  REFERENCES public.users(id)
  ON DELETE SET NULL;
