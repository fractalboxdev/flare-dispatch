-- Old intents lack trustworthy admission time and fail closed; no timestamp is inferred for them.
ALTER TABLE native_dispatches ADD COLUMN admitted_at INTEGER CHECK (admitted_at IS NULL OR admitted_at > 0);

CREATE TRIGGER native_admission_time_immutable
BEFORE UPDATE OF admitted_at ON native_dispatches
WHEN NEW.admitted_at IS NOT OLD.admitted_at
BEGIN
  SELECT RAISE(ABORT, 'native admission timestamp is immutable');
END;
