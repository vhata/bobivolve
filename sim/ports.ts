// Capability ports. The sim core imports nothing host-specific; instead, the
// host injects implementations of these interfaces. ARCHITECTURE.md
// "Determinism disciplines: No host APIs in sim".

// Persistent byte storage. The browser host backs it with OPFS, the Node host
// backs it with the filesystem, both serving the same NDJSON event log shape.
//
// `append` is a separate operation rather than read-modify-write because the
// event log is the dominant write workload and append is the cheap path on
// every backing store we plan to use.
export interface Storage {
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, data: Uint8Array): Promise<void>;
  append(key: string, data: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}
