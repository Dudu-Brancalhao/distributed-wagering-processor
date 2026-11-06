// Database migrations arrive with the persistence slice (S-03). Until then this is a no-op so the
// Compose `setup` service already runs the final command sequence.
console.log(JSON.stringify({ event: "db.migrations_skipped", reason: "no migrations defined yet" }));
