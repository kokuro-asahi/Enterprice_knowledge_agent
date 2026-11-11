export class Store<T> {
  private listeners = new Set<() => void>();
  constructor(protected state: T) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  protected patch(values: Partial<T>) {
    this.state = { ...this.state, ...values };
    this.listeners.forEach(listener => listener());
  }
}
