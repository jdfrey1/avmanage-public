-- Fixed display color per member (schedule dots, name pills). NULL = next unused color.
ALTER TABLE partnership_members ADD COLUMN IF NOT EXISTS color text;
