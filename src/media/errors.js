export class MediaError extends Error {
  constructor(message) { super(message); this.name = 'MediaError'; }
}
