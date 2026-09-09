import { connect as ownConnect } from './inplace-self-import.mjs'

export function connect () {
  return 'connected'
}

export function query () {
  return ownConnect() + ':queried'
}
