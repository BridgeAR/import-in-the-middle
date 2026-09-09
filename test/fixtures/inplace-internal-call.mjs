export function connect () {
  return 'connected'
}

export function query () {
  // Internal call to the module's own exported `connect`.
  return connect() + ':queried'
}
