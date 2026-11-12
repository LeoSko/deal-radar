// Provider API hosts the scanners call directly (the Wolt endpoint templates live in
// wolt_auth.json). Each one can be overridden from the environment, for example to
// point a scanner at a proxy or at a recorded-fixture server.
export const WOLT_RESTAURANT_API = process.env.WOLT_RESTAURANT_API || "https://restaurant-api.wolt.com";
export const BOLT_API = process.env.BOLT_API || "https://deliveryuser.live.boltsvc.net";
export const BOLT_SITE = process.env.BOLT_SITE || "https://food.bolt.eu";
