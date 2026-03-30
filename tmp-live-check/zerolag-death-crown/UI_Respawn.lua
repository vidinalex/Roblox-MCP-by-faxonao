--!strict

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")

local Aether = require(ReplicatedStorage.Aether)
local RespawnManagerClient = Aether:LoadLibrary("RespawnManagerClient")
local SoundService = Aether:LoadLibrary("SoundService")
assert(RespawnManagerClient ~= nil, "[UI_Respawn] Missing library: RespawnManagerClient")

local MonetizationClient = require(ReplicatedStorage.Utils.Monetization.MonetizationClient)
local MonetizationService = require(ReplicatedStorage.Utils.Monetization.MonetizationService)

local SAVE_SHIP_OFFER_KEY = "Respawn.SaveShip"
local DISABLED_IMAGE_TRANSPARENCY = 0.35
local PURCHASE_SOUND = ReplicatedStorage:WaitForChild("Sounds"):WaitForChild("UI"):WaitForChild("Purchase")

local M = {}

M._uiService = nil :: any
M._screenDef = nil :: any
M._gui = nil :: ScreenGui?
M._titleTL = nil :: TextLabel?
M._saveShipIB = nil :: GuiButton?
M._saveShipDescTL = nil :: TextLabel?
M._respawnDescTL = nil :: TextLabel?
M._respawnUpdatedConn = nil :: any
M._saveShipConn = nil :: RBXScriptConnection?
M._timerConn = nil :: RBXScriptConnection?
M._timerAccum = 0
M._isOpen = false
M._promptPending = false

local function resolvePath(root: Instance, path: { string }): Instance?
	local current: Instance? = root
	for _, name in ipairs(path) do
		if current == nil then
			return nil
		end
		current = current:FindFirstChild(name)
	end
	return current
end

local function setButtonEnabled(button: GuiButton?, enabled: boolean)
	if button == nil then
		return
	end
	button.Active = enabled
	button.AutoButtonColor = enabled
	if button:IsA("ImageButton") then
		button.ImageTransparency = if enabled then 0 else DISABLED_IMAGE_TRANSPARENCY
	end
end

local function canPromptSaveShip(state: any): boolean
	local offer = MonetizationService.GetOfferByKey(SAVE_SHIP_OFFER_KEY)
	if offer == nil or offer.enabled ~= true then
		return false
	end
	return state ~= nil and state.status == "waiting_auto" and state.canSaveShip == true
end

local function formatLostLevelsText(lostLevels: number): string
	local count = math.max(0, math.floor(tonumber(lostLevels) or 0))
	return ("You lost %d %s"):format(count, if count == 1 then "level" else "levels")
end

function M:_applyState(state: any)
	local respawnState = state or RespawnManagerClient.GetState()

	if self._titleTL ~= nil then
		self._titleTL.Text = "Your ship has been destroyed"
	end

	if self._respawnDescTL ~= nil then
		local secondsUntilAutoRespawn = math.max(0, math.ceil((tonumber((respawnState :: any).autoRespawnAt) or 0) - Workspace:GetServerTimeNow()))
		local displaySeconds = math.max(1, secondsUntilAutoRespawn)
		local respawnText = if (respawnState :: any).status == "waiting_auto" then ("Respawn in %d"):format(displaySeconds) else "Respawning..."
		local lostLevels = math.max(0, math.floor(tonumber((respawnState :: any).lostLevels) or 0))
		if lostLevels > 0 then
			self._respawnDescTL.Text = ("%s\n%s"):format(formatLostLevelsText(lostLevels), respawnText)
		else
			self._respawnDescTL.Text = respawnText
		end
	end

	if self._saveShipDescTL ~= nil then
		if self._promptPending then
			self._saveShipDescTL.Text = "Processing"
		elseif not canPromptSaveShip(respawnState) then
			local offer = MonetizationService.GetOfferByKey(SAVE_SHIP_OFFER_KEY)
			self._saveShipDescTL.Text = if offer == nil or offer.enabled ~= true then "Unavailable" else "Save Ship"
		else
			self._saveShipDescTL.Text = if (respawnState :: any).isPreparedForPurchase == true then "Awaiting Payment" else "Save Ship"
		end
	end

	setButtonEnabled(self._saveShipIB, not self._promptPending and canPromptSaveShip(respawnState))
end

function M:_startTimer()
	if self._timerConn ~= nil then
		return
	end
	self._timerAccum = 0
	self._timerConn = RunService.Heartbeat:Connect(function(dt: number)
		self._timerAccum += dt
		if self._timerAccum < 0.1 then
			return
		end
		self._timerAccum = 0
		if self._isOpen then
			self:_applyState(RespawnManagerClient.GetState())
		end
	end)
end

function M:_stopTimer()
	if self._timerConn ~= nil then
		self._timerConn:Disconnect()
	end
	self._timerConn = nil
	self._timerAccum = 0
end

function M:Init(uiService: any, screenDef: any)
	self._uiService = uiService
	self._screenDef = screenDef
end

function M:Bind(gui: ScreenGui)
	self._gui = gui

	local titleInst = resolvePath(gui, { "Holder", "TitleTL" })
	self._titleTL = if titleInst ~= nil and titleInst:IsA("TextLabel") then titleInst else nil

	local saveInst = resolvePath(gui, { "Holder", "SaveShipIB" })
	self._saveShipIB = if saveInst ~= nil and saveInst:IsA("GuiButton") then saveInst else nil

	local saveDescInst = resolvePath(gui, { "Holder", "SaveShipIB", "DescTL" })
	self._saveShipDescTL = if saveDescInst ~= nil and saveDescInst:IsA("TextLabel") then saveDescInst else nil

	local respawnDescInst = resolvePath(gui, { "Holder", "RespawnIL", "DescTL" })
	self._respawnDescTL = if respawnDescInst ~= nil and respawnDescInst:IsA("TextLabel") then respawnDescInst else nil
	if self._respawnDescTL ~= nil then
		self._respawnDescTL.TextWrapped = true
	end

	if self._saveShipConn ~= nil then
		self._saveShipConn:Disconnect()
	end
	self._saveShipConn = nil

	if self._saveShipIB ~= nil then
		self._saveShipConn = self._saveShipIB.Activated:Connect(function()
			if self._promptPending then
				return
			end
			local state = RespawnManagerClient.GetState()
			if not canPromptSaveShip(state) then
				self:_applyState(state)
				return
			end
			self._promptPending = true
			self:_applyState(state)
			local okPrepare = false
			local _reason = ""
			okPrepare, _reason = RespawnManagerClient.PrepareSaveShipPurchase((state :: any).token)
			if okPrepare then
				local okPrompt = false
				okPrompt, _reason = MonetizationClient.PromptOfferPurchase(SAVE_SHIP_OFFER_KEY)
				if okPrompt and SoundService ~= nil and PURCHASE_SOUND:IsA("Sound") then
					SoundService.PlaySound(PURCHASE_SOUND)
				end
			end
			self._promptPending = false
			self:_applyState(RespawnManagerClient.RefreshState())
		end)
	end
end

function M:OnOpen(_args: any?)
	self._isOpen = true
	self:_applyState(RespawnManagerClient.GetState())
	self:_startTimer()

	if self._respawnUpdatedConn ~= nil and type(self._respawnUpdatedConn.Disconnect) == "function" then
		self._respawnUpdatedConn:Disconnect()
	end
	self._respawnUpdatedConn = RespawnManagerClient.respawnUpdated:Connect(function(state: any)
		if self._isOpen then
			self:_applyState(state)
		end
	end)

	task.spawn(function()
		local state = RespawnManagerClient.RefreshState()
		if self._isOpen then
			self:_applyState(state)
		end
	end)
end

function M:OnClose(_args: any?, _reason: string?)
	self._isOpen = false
	self._promptPending = false
	self:_stopTimer()
	if self._respawnUpdatedConn ~= nil and type(self._respawnUpdatedConn.Disconnect) == "function" then
		self._respawnUpdatedConn:Disconnect()
	end
	self._respawnUpdatedConn = nil
end

function M:Destroy()
	self:OnClose(nil, "Destroy")
	if self._saveShipConn ~= nil then
		self._saveShipConn:Disconnect()
	end
	self._saveShipConn = nil
	self._gui = nil
	self._titleTL = nil
	self._saveShipIB = nil
	self._saveShipDescTL = nil
	self._respawnDescTL = nil
	self._uiService = nil
	self._screenDef = nil
end

return M
