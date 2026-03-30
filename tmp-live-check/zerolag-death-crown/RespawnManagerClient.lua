--!strict

local Workspace = game:GetService("Workspace")

local Aether = require(game.ReplicatedStorage.Aether)
local RespawnService = Aether:LoadLibrary("RespawnService")
local Event = require(game.ReplicatedStorage.Utils.Classes.Other.Event)

local BoatManagerClient = Aether:LoadLibrary("BoatManagerClient")

export type RespawnState = {
	token: number,
	status: string,
	autoRespawnAt: number,
	canSaveShip: boolean,
	isPreparedForPurchase: boolean,
	lostLevels: number,
	secondsUntilAutoRespawn: number,
}

local RespawnManagerClient = {}
RespawnManagerClient.respawnUpdated = Event.New()

local started = false
local uiServiceRef = nil :: any
local currentState: RespawnState = {
	token = 0,
	status = "idle",
	autoRespawnAt = 0,
	canSaveShip = false,
	isPreparedForPurchase = false,
	lostLevels = 0,
	secondsUntilAutoRespawn = 0,
}
local lastSignature = ""

local function normalizeState(raw: any): RespawnState
	local autoRespawnAt = math.max(0, tonumber(raw and raw.autoRespawnAt) or 0)
	return {
		token = math.max(0, math.floor(tonumber(raw and raw.token) or 0)),
		status = tostring(raw and raw.status or "idle"),
		autoRespawnAt = autoRespawnAt,
		canSaveShip = raw and raw.canSaveShip == true or false,
		isPreparedForPurchase = raw and raw.isPreparedForPurchase == true or false,
		lostLevels = math.max(0, math.floor(tonumber(raw and raw.lostLevels) or 0)),
		secondsUntilAutoRespawn = math.max(0, math.ceil(autoRespawnAt - Workspace:GetServerTimeNow())),
	}
end

local function getSignature(state: RespawnState): string
	return string.format(
		"%d|%s|%d|%s|%s|%d",
		state.token,
		state.status,
		state.secondsUntilAutoRespawn,
		tostring(state.canSaveShip),
		tostring(state.isPreparedForPurchase),
		state.lostLevels
	)
end

local function applyUiState()
	if uiServiceRef == nil then
		return
	end

	if currentState.status == "waiting_auto" then
		uiServiceRef:Open("Respawn")
	else
		uiServiceRef:Close("Respawn", nil, "RespawnStateChanged")
	end
end

local function emitIfChanged(force: boolean)
	currentState = normalizeState(currentState)
	local signature = getSignature(currentState)
	if not force and signature == lastSignature then
		return
	end
	lastSignature = signature
	RespawnManagerClient.respawnUpdated:Fire(currentState)
	applyUiState()
end

local function applyServerState(raw: any, force: boolean?)
	currentState = normalizeState(raw)
	emitIfChanged(force == true)
end

local function ensureStarted()
	if started then
		return
	end
	started = true

	RespawnService._NET.STATE_CHANGED.OnClientEvent:Connect(function(rawState: any)
		applyServerState(rawState, true)
	end)

	if BoatManagerClient ~= nil and typeof((BoatManagerClient :: any).onMyBoatChanged) == "table" then
		(BoatManagerClient :: any).onMyBoatChanged:Connect(function()
			task.delay(0.1, function()
				RespawnManagerClient.RefreshState()
			end)
		end)
	end
end

function RespawnManagerClient.Init(uiService: any)
	ensureStarted()
	uiServiceRef = uiService
	RespawnManagerClient.RefreshState()
	applyUiState()
end

function RespawnManagerClient.GetState(): RespawnState
	ensureStarted()
	currentState = normalizeState(currentState)
	return currentState
end

function RespawnManagerClient.RefreshState(): RespawnState
	ensureStarted()
	local okInvoke, response = pcall(function()
		return RespawnService._NET.GET_STATE:InvokeServer()
	end)
	if okInvoke then
		applyServerState(response, true)
	else
		emitIfChanged(false)
	end
	return currentState
end

function RespawnManagerClient.PrepareSaveShipPurchase(token: number): (boolean, string, RespawnState)
	ensureStarted()
	local okInvoke, response = pcall(function()
		return RespawnService._NET.PREPARE_SAVE_SHIP_PURCHASE:InvokeServer({
			token = math.max(0, math.floor(tonumber(token) or 0)),
		})
	end)
	if okInvoke and typeof(response) == "table" then
		if typeof((response :: any).state) == "table" then
			applyServerState((response :: any).state, true)
		end
		return (response :: any).ok == true, tostring((response :: any).reason or "Unknown"), currentState
	end
	return false, "InvokeFailed", currentState
end

ensureStarted()

table.freeze(RespawnManagerClient)
return RespawnManagerClient