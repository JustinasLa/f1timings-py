/* Shared runtime state mutated across modules. */

let currentTrack = "";
let trackData = null;
let socket;
let canvas, ctx;
let trackRendered = false;
let fetchDataInterval = null;
let driverAliases = {};
let latestLiveDrivers = {};
// Driver names whose row is expanded to show their recent laps, plus the last
// drivers object we rendered (so toggling can re-render without a new fetch).
let expandedDrivers = new Set();
let latestLeaderboardDrivers = {};
