-- Drive copy of each Garmin log's Google Earth (KML) track.
ALTER TABLE public.garmin_data_logs ADD COLUMN IF NOT EXISTS kml_drive_file_id TEXT;
