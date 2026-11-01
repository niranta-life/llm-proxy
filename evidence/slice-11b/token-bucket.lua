-- Token bucket for one tenant. One key keeps one Redis Cluster slot.
-- Redis TIME is the only clock. Amounts are milli-tokens.
local SCALE = 1000
local MAX_FIELDS = 2048

local key = KEYS[1]
local tenant = ARGV[1]
local attempt = ARGV[2]
local ttl = tonumber(ARGV[3])
local count = tonumber(ARGV[4])

local tag = string.match(key, "^rl:{([^}]+)}:v[0-9a-f]+$")
if tag == nil or tag ~= tenant then
  return {"ok", "deny", "0", "0", "wrong_tenant"}
end
if ttl == nil or ttl < 1 or ttl > 600 then
  return {"ok", "deny", "0", "0", "bad_request"}
end
if attempt == nil or string.match(attempt, "^[0-9a-f%-]+$") == nil or #attempt < 32 or #attempt > 64 then
  return {"ok", "deny", "0", "0", "bad_request"}
end
if count == nil or count < 1 or count > 4 then
  return {"ok", "deny", "0", "0", "bad_request"}
end

local seen = "s:" .. attempt
local previous = redis.call("HGET", key, seen)
if previous ~= false and previous ~= nil then
  local decision, remaining = string.match(tostring(previous), "^(allow):([0-9]+)$")
  if decision == nil then
    decision, remaining = string.match(tostring(previous), "^(deny):([0-9]+)$")
  end
  if (decision == "allow" or decision == "deny") and remaining ~= nil then
    redis.call("EXPIRE", key, ttl)
    return {"ok", decision, remaining, "1", "duplicate"}
  end
end

local names = {}
local capacities = {}
local costs = {}
local arg = 5
for i = 1, count do
  local name = ARGV[arg]
  local capacity = tonumber(ARGV[arg + 1])
  local cost = tonumber(ARGV[arg + 2])
  arg = arg + 3
  if name == nil or string.match(name, "^[a-z0-9:_-]+$") == nil or #name > 80 then
    return {"ok", "deny", "0", "0", "bad_request"}
  end
  if capacity == nil or capacity < 1 or capacity > 1000000000 or math.floor(capacity) ~= capacity then
    return {"ok", "deny", "0", "0", "bad_request"}
  end
  if cost == nil or cost < 1 or cost > 1000000000 or math.floor(cost) ~= cost then
    return {"ok", "deny", "0", "0", "bad_request"}
  end
  names[i] = name
  capacities[i] = capacity
  costs[i] = cost
end

local time = redis.call("TIME")
local now = tonumber(time[1]) * 1000000 + tonumber(time[2])
local levels = {}
local residuals = {}
local allow = true
for i = 1, count do
  local capacity = capacities[i]
  local cost = costs[i]
  local raw = redis.call("HGET", key, "t:" .. names[i])
  local stamp = redis.call("HGET", key, "m:" .. names[i])
  local tokens = capacity * SCALE
  local residual = 0
  if raw ~= false and raw ~= nil and stamp ~= false and stamp ~= nil then
    tokens = tonumber(raw)
    local then_us = tonumber(stamp)
    if tokens == nil or then_us == nil then
      tokens = capacity * SCALE
    else
      local elapsed = now - then_us
      if elapsed < 0 then elapsed = 0 end
      if elapsed > 3600000000 then elapsed = 3600000000 end
      -- Sub-quantum credit stays in r:. Moving the stamp alone drops it.
      local carried = tonumber(redis.call("HGET", key, "r:" .. names[i]))
      if carried == nil or carried < 0 or carried >= 60000 then carried = 0 end
      local whole = math.floor(elapsed / 60000) * capacity
      local frac_num = (elapsed % 60000) * capacity + carried
      local frac = math.floor(frac_num / 60000)
      residual = frac_num % 60000
      tokens = tokens + whole + frac
      local full = capacity * SCALE
      if tokens >= full then
        tokens = full
        residual = 0
      end
      if tokens < 0 then tokens = 0 end
    end
  end
  levels[i] = tokens
  residuals[i] = residual
  if tokens < cost * SCALE then allow = false end
end

local decision = "deny"
if allow then decision = "allow" end
local tight = nil
for i = 1, count do
  local stored = levels[i]
  if allow then stored = levels[i] - costs[i] * SCALE end
  if tight == nil or stored < tight then tight = stored end
  redis.call("HSET", key, "t:" .. names[i], tostring(math.floor(stored)))
  redis.call("HSET", key, "m:" .. names[i], tostring(math.floor(now)))
  redis.call("HSET", key, "r:" .. names[i], tostring(math.floor(residuals[i])))
end
if redis.call("HLEN", key) >= MAX_FIELDS then
  local all = redis.call("HGETALL", key)
  local removed = 0
  for i = 1, #all, 2 do
    local field = all[i]
    if string.sub(field, 1, 2) == "s:" and field ~= seen then
      redis.call("HDEL", key, field)
      removed = removed + 1
      if removed >= 32 then break end
    end
  end
end
if redis.call("HLEN", key) < MAX_FIELDS then
  redis.call("HSET", key, seen, decision .. ":" .. tostring(math.floor(tight)))
end
redis.call("EXPIRE", key, ttl)
return {"ok", decision, tostring(math.floor(tight)), "0", "ok"}
