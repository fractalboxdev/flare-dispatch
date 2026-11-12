-- Existing policy-less intents retain their original authority; controller deadlines are never inferred or refreshed.
ALTER TABLE native_dispatches ADD COLUMN timeout_sec INTEGER CHECK (timeout_sec IS NULL OR (typeof(timeout_sec) = 'integer' AND timeout_sec > 0));
ALTER TABLE native_dispatches ADD COLUMN deadline_at INTEGER CHECK (deadline_at IS NULL OR (typeof(deadline_at) = 'integer' AND deadline_at > 0));

CREATE TRIGGER native_controller_deadline_insert
BEFORE INSERT ON native_dispatches
WHEN (NEW.timeout_sec IS NULL) != (NEW.deadline_at IS NULL)
  OR (NEW.timeout_sec IS NOT NULL AND (NEW.admitted_at IS NULL OR NEW.deadline_at != NEW.admitted_at + NEW.timeout_sec))
BEGIN
  SELECT RAISE(ABORT, 'native controller deadline policy is inconsistent');
END;

CREATE TRIGGER native_controller_deadline_immutable
BEFORE UPDATE OF timeout_sec, deadline_at ON native_dispatches
WHEN NEW.timeout_sec IS NOT OLD.timeout_sec OR NEW.deadline_at IS NOT OLD.deadline_at
BEGIN
  SELECT RAISE(ABORT, 'native controller deadline policy is immutable');
END;
