
local tenant = ARGV[1]
local attempt = ARGV[2]
local ttl = tonumber(ARGV[3])
local count = tonumber(ARGV[4])
if count == nil or count ~= #KEYS or count < 1 or ttl == nil or ttl < 1 then
  return {"ok","deny","0","0","bad_request"}
end
for i = 1, #KEYS do
  local tag = string.match(KEYS[i], "^rl:{([^}]+)}")
  if tag ~= tenant then
    return {"ok","deny","0","0","wrong_tenant"}
  end
end
local seen = "s:" .. attempt
local prior = nil
for i = 1, #KEYS do
  local prev = redis.call("HGET", KEYS[i], seen)
  if prev == false or prev == nil then
    if prior ~= nil then
      return {"ok","missing","0","0","split"}
    end
  else
    if prior == nil then
      prior = prev
    elseif prior ~= prev then
      return {"ok","missing","0","0","split"}
    end
  end
end
if prior ~= nil then
  local decision, remaining = string.match(prior, "^(%a+):(%d+)$")
  if decision ~= "allow" and decision ~= "deny" then
    return {"ok","missing","0","0","invalid"}
  end
  return {"ok", decision, remaining, "1", "duplicate"}
end
local levels = {}
local tight = nil
for i = 1, #KEYS do
  local cost = tonumber(ARGV[4 + i])
  local raw = redis.call("HGET", KEYS[i], "n")
  if raw == false or raw == nil then
    return {"ok","missing","0","0","missing"}
  end
  local level = tonumber(raw)
  if level == nil or cost == nil or cost < 1 then
    return {"ok","deny","0","0","bad_request"}
  end
  if level < cost then
    for j = 1, #KEYS do
      redis.call("HSET", KEYS[j], seen, "deny:" .. tostring(math.floor(level)))
      redis.call("EXPIRE", KEYS[j], ttl)
    end
    return {"ok","deny", tostring(math.floor(level)), "0", "empty"}
  end
  levels[i] = level - cost
  if tight == nil or levels[i] < tight then
    tight = levels[i]
  end
end
for i = 1, #KEYS do
  redis.call("HSET", KEYS[i], "n", tostring(math.floor(levels[i])))
  redis.call("HSET", KEYS[i], seen, "allow:" .. tostring(math.floor(tight)))
  redis.call("EXPIRE", KEYS[i], ttl)
end
return {"ok","allow", tostring(math.floor(tight)), "0", "ok"}
