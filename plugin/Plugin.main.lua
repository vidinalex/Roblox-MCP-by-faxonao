local HttpService = game:GetService("HttpService")
local LogService = game:GetService("LogService")
local RunService = game:GetService("RunService")
local TweenService = game:GetService("TweenService")
local ScriptEditorService = nil
pcall(function()
	ScriptEditorService = game:GetService("ScriptEditorService")
end)

local PLUGIN_VERSION = "0.2.0"
local LEGACY_BRIDGE_URL = "http://127.0.0.1:5000/v1/studio"
local DEFAULT_BRIDGE_URL = "http://127.0.0.1:5100/v1/studio"
local POLL_WAIT_MS = 25000
local LOG_LIMIT = 300
local LOG_RENDER_THROTTLE = 0.08
local PROJECT_PROFILES_KEY = "rbxmcp_project_profiles_v1"
local PRODUCT_NAME = "Aether MCP Bridge"
local PRODUCT_SUBTITLE = "made by faxonao"
local PRODUCT_ICON = "rbxassetid://96280057659640"

local COLORS = {
	primary = Color3.fromRGB(113, 70, 255),
	secondary = Color3.fromRGB(155, 92, 255),
	background = Color3.fromRGB(10, 11, 24),
	backgroundAlt = Color3.fromRGB(16, 13, 34),
	accent = Color3.fromRGB(214, 168, 79),
	surface = Color3.fromRGB(19, 17, 40),
	surfaceAlt = Color3.fromRGB(31, 26, 61),
	surfaceElevated = Color3.fromRGB(42, 35, 78),
	textMain = Color3.fromRGB(243, 239, 255),
	textDim = Color3.fromRGB(168, 158, 214),
	textMuted = Color3.fromRGB(120, 111, 161),
	danger = Color3.fromRGB(224, 95, 132),
	warn = Color3.fromRGB(224, 179, 84),
	success = Color3.fromRGB(93, 208, 151),
	info = Color3.fromRGB(110, 166, 255),
	border = Color3.fromRGB(91, 72, 146),
}

local toolbar = plugin:CreateToolbar(PRODUCT_NAME)
local openButton = toolbar:CreateButton(PRODUCT_NAME, "Open " .. PRODUCT_NAME .. " panel", PRODUCT_ICON)

local widgetInfo = DockWidgetPluginGuiInfo.new(
	Enum.InitialDockState.Left,
	true,
	false,
	440,
	540,
	360,
	260
)
local widget = plugin:CreateDockWidgetPluginGui("RBXMCPDock", widgetInfo)
widget.Title = PRODUCT_NAME

local container = Instance.new("Frame")
container.Size = UDim2.fromScale(1, 1)
container.BackgroundColor3 = COLORS.background
container.BorderSizePixel = 0
container.Parent = widget

local gradient = Instance.new("UIGradient")
gradient.Color = ColorSequence.new({
	ColorSequenceKeypoint.new(0, COLORS.background),
	ColorSequenceKeypoint.new(0.55, COLORS.backgroundAlt),
	ColorSequenceKeypoint.new(1, Color3.fromRGB(8, 7, 20)),
})
gradient.Rotation = 35
gradient.Parent = container

local pad = Instance.new("UIPadding")
pad.PaddingLeft = UDim.new(0, 12)
pad.PaddingRight = UDim.new(0, 12)
pad.PaddingTop = UDim.new(0, 12)
pad.PaddingBottom = UDim.new(0, 12)
pad.Parent = container

local layout = Instance.new("UIListLayout")
layout.FillDirection = Enum.FillDirection.Vertical
layout.Padding = UDim.new(0, 10)
layout.HorizontalAlignment = Enum.HorizontalAlignment.Center
layout.Parent = container

local function tween(instance, info, props)
	if not instance then
		return
	end
	local ok, anim = pcall(function()
		return TweenService:Create(instance, info, props)
	end)
	if ok and anim then
		anim:Play()
	else
		for key, value in pairs(props) do
			instance[key] = value
		end
	end
end

local function styleCard(card)
	card.BackgroundColor3 = COLORS.surface
	card.BorderSizePixel = 0
	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 10)
	corner.Parent = card
	local stroke = Instance.new("UIStroke")
	stroke.Color = COLORS.border
	stroke.Transparency = 0.18
	stroke.Thickness = 1
	stroke.Parent = card
	local inner = Instance.new("UIGradient")
	inner.Color = ColorSequence.new({
		ColorSequenceKeypoint.new(0, COLORS.surfaceElevated),
		ColorSequenceKeypoint.new(1, COLORS.surface),
	})
	inner.Transparency = NumberSequence.new({
		NumberSequenceKeypoint.new(0, 0.42),
		NumberSequenceKeypoint.new(1, 0.08),
	})
	inner.Parent = card
end

local function styleButton(btn, fill, textColor)
	btn.BackgroundColor3 = fill
	btn.TextColor3 = textColor or COLORS.textMain
	btn.Font = Enum.Font.FredokaOne
	btn.TextSize = 13
	btn.AutoButtonColor = false
	btn.BorderSizePixel = 0
	btn.TextTruncate = Enum.TextTruncate.AtEnd
	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 8)
	corner.Parent = btn
	local hovered = false
	btn.MouseEnter:Connect(function()
		hovered = true
		tween(btn, TweenInfo.new(0.12, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { BackgroundTransparency = 0.06 })
	end)
	btn.MouseLeave:Connect(function()
		hovered = false
		tween(btn, TweenInfo.new(0.12, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { BackgroundTransparency = 0 })
	end)
	btn.MouseButton1Down:Connect(function()
		tween(btn, TweenInfo.new(0.08, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { BackgroundTransparency = 0.12 })
	end)
	btn.MouseButton1Up:Connect(function()
		tween(btn, TweenInfo.new(0.1, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {
			BackgroundTransparency = hovered and 0.06 or 0
		})
	end)
end

local function insetText(guiObject, left, right)
	local padding = Instance.new("UIPadding")
	padding.PaddingLeft = UDim.new(0, left or 10)
	padding.PaddingRight = UDim.new(0, right or left or 10)
	padding.Parent = guiObject
	return padding
end

local function nowIso()
	return DateTime.now():ToIsoDate()
end

local function shortText(text, limit)
	local t = tostring(text or "")
	local maxLen = limit or 120
	if #t <= maxLen then
		return t
	end
	return t:sub(1, maxLen - 1) .. "..."
end

local headerCard = Instance.new("Frame")
headerCard.Size = UDim2.new(1, 0, 0, 128)
headerCard.Parent = container
styleCard(headerCard)

local bodyFrame = Instance.new("Frame")
bodyFrame.Size = UDim2.new(1, 0, 0, 380)
bodyFrame.BackgroundTransparency = 1
bodyFrame.ClipsDescendants = true
bodyFrame.Parent = container

local mainPage = Instance.new("Frame")
mainPage.Size = UDim2.fromScale(1, 1)
mainPage.Position = UDim2.fromScale(0, 0)
mainPage.BackgroundTransparency = 1
mainPage.Parent = bodyFrame

local mainPageLayout = Instance.new("UIListLayout")
mainPageLayout.FillDirection = Enum.FillDirection.Vertical
mainPageLayout.Padding = UDim.new(0, 10)
mainPageLayout.HorizontalAlignment = Enum.HorizontalAlignment.Center
mainPageLayout.Parent = mainPage

local helperPage = Instance.new("Frame")
helperPage.Size = UDim2.fromScale(1, 1)
helperPage.Position = UDim2.fromScale(1, 0)
helperPage.BackgroundTransparency = 1
helperPage.Parent = bodyFrame

local heroGlow = Instance.new("Frame")
heroGlow.Size = UDim2.new(0.72, 0, 1, 0)
heroGlow.Position = UDim2.new(0, 0, 0, 0)
heroGlow.BackgroundColor3 = COLORS.secondary
heroGlow.BackgroundTransparency = 0.82
heroGlow.BorderSizePixel = 0
heroGlow.Parent = headerCard
local heroGlowCorner = Instance.new("UICorner")
heroGlowCorner.CornerRadius = UDim.new(0, 18)
heroGlowCorner.Parent = heroGlow
local heroGlowGradient = Instance.new("UIGradient")
heroGlowGradient.Color = ColorSequence.new({
	ColorSequenceKeypoint.new(0, COLORS.secondary),
	ColorSequenceKeypoint.new(1, COLORS.primary),
})
heroGlowGradient.Transparency = NumberSequence.new({
	NumberSequenceKeypoint.new(0, 0.18),
	NumberSequenceKeypoint.new(1, 0.95),
})
heroGlowGradient.Parent = heroGlow

local heroIcon = Instance.new("ImageLabel")
heroIcon.Size = UDim2.new(0, 68, 0, 68)
heroIcon.Position = UDim2.new(0, 14, 0, 22)
heroIcon.BackgroundTransparency = 1
heroIcon.Image = PRODUCT_ICON
heroIcon.ScaleType = Enum.ScaleType.Fit
heroIcon.Parent = headerCard

local heroSpinAngle = 0

local function animateHeroIcon()
	heroSpinAngle = heroSpinAngle + 18
	tween(heroIcon, TweenInfo.new(0.32, Enum.EasingStyle.Quart, Enum.EasingDirection.Out), {
		Rotation = heroSpinAngle,
	})
	tween(heroGlow, TweenInfo.new(0.16, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {
		BackgroundTransparency = 0.72,
	})
	task.delay(0.18, function()
		tween(heroGlow, TweenInfo.new(0.28, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {
			BackgroundTransparency = 0.82,
		})
	end)
end

local title = Instance.new("TextLabel")
title.Size = UDim2.new(1, -112, 0, 26)
title.Position = UDim2.new(0, 96, 0, 18)
title.BackgroundTransparency = 1
title.TextColor3 = COLORS.textMain
title.TextXAlignment = Enum.TextXAlignment.Left
title.Font = Enum.Font.FredokaOne
title.TextSize = 20
title.Text = PRODUCT_NAME
title.Parent = headerCard

local creditLabel = Instance.new("TextLabel")
creditLabel.Size = UDim2.new(1, -112, 0, 16)
creditLabel.Position = UDim2.new(0, 96, 0, 44)
creditLabel.BackgroundTransparency = 1
creditLabel.TextColor3 = COLORS.textMuted
creditLabel.TextXAlignment = Enum.TextXAlignment.Left
creditLabel.Font = Enum.Font.GothamMedium
creditLabel.TextSize = 10
creditLabel.Text = PRODUCT_SUBTITLE
creditLabel.Parent = headerCard

local statusBadge = Instance.new("TextLabel")
statusBadge.Size = UDim2.new(0, 130, 0, 24)
statusBadge.Position = UDim2.new(0, 96, 0, 68)
statusBadge.BackgroundColor3 = COLORS.secondary
statusBadge.TextColor3 = COLORS.textMain
statusBadge.Font = Enum.Font.FredokaOne
statusBadge.TextSize = 11
statusBadge.Text = "IDLE"
statusBadge.Parent = headerCard
local statusBadgeCorner = Instance.new("UICorner")
statusBadgeCorner.CornerRadius = UDim.new(1, 0)
statusBadgeCorner.Parent = statusBadge

local quickStartButton = Instance.new("TextButton")
quickStartButton.Size = UDim2.new(0, 108, 0, 26)
quickStartButton.Position = UDim2.new(1, -118, 0, 12)
quickStartButton.Text = "Quick Start"
quickStartButton.Parent = headerCard
styleButton(quickStartButton, COLORS.primary)
insetText(quickStartButton, 10, 10)

local statusLabel = Instance.new("TextLabel")
statusLabel.Size = UDim2.new(0.48, -9, 0, 16)
statusLabel.Position = UDim2.new(0, 9, 0, 92)
statusLabel.BackgroundTransparency = 1
statusLabel.TextColor3 = COLORS.textDim
statusLabel.TextXAlignment = Enum.TextXAlignment.Left
statusLabel.Font = Enum.Font.GothamMedium
statusLabel.TextSize = 11
statusLabel.Text = "Status: idle"
statusLabel.Parent = headerCard

local syncLabel = Instance.new("TextLabel")
syncLabel.Size = UDim2.new(1, -18, 0, 14)
syncLabel.Position = UDim2.new(0, 9, 0, 104)
syncLabel.BackgroundTransparency = 1
syncLabel.TextColor3 = COLORS.textDim
syncLabel.TextXAlignment = Enum.TextXAlignment.Left
syncLabel.Font = Enum.Font.GothamMedium
syncLabel.TextSize = 10
syncLabel.Text = "Last sync: never"
syncLabel.Parent = headerCard

local connectionCard = Instance.new("Frame")
connectionCard.Size = UDim2.new(1, 0, 0, 236)
connectionCard.Parent = mainPage
styleCard(connectionCard)

local urlLabel = Instance.new("TextLabel")
urlLabel.Size = UDim2.new(1, -18, 0, 18)
urlLabel.Position = UDim2.new(0, 9, 0, 8)
urlLabel.BackgroundTransparency = 1
urlLabel.TextColor3 = COLORS.textMain
urlLabel.TextXAlignment = Enum.TextXAlignment.Left
urlLabel.Font = Enum.Font.FredokaOne
urlLabel.TextSize = 12
urlLabel.Text = "Connection (port-first)"
urlLabel.Parent = connectionCard

local portLabel = Instance.new("TextLabel")
portLabel.Size = UDim2.new(1, -18, 0, 16)
portLabel.Position = UDim2.new(0, 9, 0, 30)
portLabel.BackgroundTransparency = 1
portLabel.TextColor3 = COLORS.textDim
portLabel.TextXAlignment = Enum.TextXAlignment.Left
portLabel.Font = Enum.Font.GothamMedium
portLabel.TextSize = 11
portLabel.Text = "Port"
portLabel.Parent = connectionCard

local urlInput = Instance.new("TextBox")
urlInput.Size = UDim2.new(1, -18, 0, 30)
urlInput.Position = UDim2.new(0, 9, 0, 48)
urlInput.Parent = connectionCard
urlInput.BackgroundColor3 = COLORS.surfaceAlt
urlInput.TextColor3 = COLORS.textMain
urlInput.PlaceholderColor3 = COLORS.textDim
urlInput.TextXAlignment = Enum.TextXAlignment.Left
urlInput.ClearTextOnFocus = false
urlInput.Font = Enum.Font.Gotham
urlInput.TextSize = 12
urlInput.PlaceholderText = "5100"
insetText(urlInput, 10, 10)
local urlCorner = Instance.new("UICorner")
urlCorner.CornerRadius = UDim.new(0, 8)
urlCorner.Parent = urlInput

local portErrorLabel = Instance.new("TextLabel")
portErrorLabel.Size = UDim2.new(1, -18, 0, 16)
portErrorLabel.Position = UDim2.new(0, 9, 0, 80)
portErrorLabel.BackgroundTransparency = 1
portErrorLabel.TextColor3 = COLORS.danger
portErrorLabel.TextXAlignment = Enum.TextXAlignment.Left
portErrorLabel.Font = Enum.Font.GothamMedium
portErrorLabel.TextSize = 11
portErrorLabel.Text = ""
portErrorLabel.Visible = false
portErrorLabel.Parent = connectionCard

local fullUrlLabel = Instance.new("TextLabel")
fullUrlLabel.Size = UDim2.new(1, -18, 0, 16)
fullUrlLabel.Position = UDim2.new(0, 9, 0, 98)
fullUrlLabel.BackgroundTransparency = 1
fullUrlLabel.TextColor3 = COLORS.textDim
fullUrlLabel.TextXAlignment = Enum.TextXAlignment.Left
fullUrlLabel.Font = Enum.Font.GothamMedium
fullUrlLabel.TextSize = 11
fullUrlLabel.Text = "Full URL"
fullUrlLabel.Parent = connectionCard

local fullUrlPreview = Instance.new("TextBox")
fullUrlPreview.Size = UDim2.new(1, -18, 0, 28)
fullUrlPreview.Position = UDim2.new(0, 9, 0, 116)
fullUrlPreview.BackgroundColor3 = COLORS.surfaceAlt
fullUrlPreview.TextColor3 = COLORS.textMain
fullUrlPreview.PlaceholderColor3 = COLORS.textDim
fullUrlPreview.TextXAlignment = Enum.TextXAlignment.Left
fullUrlPreview.ClearTextOnFocus = false
fullUrlPreview.TextEditable = false
fullUrlPreview.Font = Enum.Font.Gotham
fullUrlPreview.TextSize = 11
fullUrlPreview.Parent = connectionCard
insetText(fullUrlPreview, 10, 10)
local fullUrlCorner = Instance.new("UICorner")
fullUrlCorner.CornerRadius = UDim.new(0, 8)
fullUrlCorner.Parent = fullUrlPreview

local advancedToggleButton = Instance.new("TextButton")
advancedToggleButton.Size = UDim2.new(1, -18, 0, 24)
advancedToggleButton.Position = UDim2.new(0, 9, 0, 148)
advancedToggleButton.Text = "Advanced host edit"
advancedToggleButton.Parent = connectionCard
styleButton(advancedToggleButton, COLORS.secondary)
insetText(advancedToggleButton, 10, 10)
advancedToggleButton.Visible = false

local advancedFrame = Instance.new("Frame")
advancedFrame.Size = UDim2.new(1, -18, 0, 32)
advancedFrame.Position = UDim2.new(0, 9, 0, 176)
advancedFrame.BackgroundTransparency = 1
advancedFrame.ClipsDescendants = true
advancedFrame.Parent = connectionCard

local hostInput = Instance.new("TextBox")
hostInput.Size = UDim2.new(0.68, -4, 0, 30)
hostInput.Position = UDim2.new(0, 0, 0, 0)
hostInput.BackgroundColor3 = COLORS.surfaceAlt
hostInput.TextColor3 = COLORS.textMain
hostInput.PlaceholderColor3 = COLORS.textDim
hostInput.TextXAlignment = Enum.TextXAlignment.Left
hostInput.ClearTextOnFocus = false
hostInput.Font = Enum.Font.Gotham
hostInput.TextSize = 11
hostInput.PlaceholderText = "127.0.0.1"
hostInput.Parent = advancedFrame
insetText(hostInput, 10, 10)
local hostCorner = Instance.new("UICorner")
hostCorner.CornerRadius = UDim.new(0, 8)
hostCorner.Parent = hostInput

local schemeInput = Instance.new("TextBox")
schemeInput.Size = UDim2.new(0.32, -2, 0, 30)
schemeInput.Position = UDim2.new(0.68, 6, 0, 0)
schemeInput.BackgroundColor3 = COLORS.surfaceAlt
schemeInput.TextColor3 = COLORS.textMain
schemeInput.PlaceholderColor3 = COLORS.textDim
schemeInput.TextXAlignment = Enum.TextXAlignment.Left
schemeInput.ClearTextOnFocus = false
schemeInput.Font = Enum.Font.Gotham
schemeInput.TextSize = 11
schemeInput.PlaceholderText = "http"
schemeInput.Parent = advancedFrame
insetText(schemeInput, 10, 10)
local schemeCorner = Instance.new("UICorner")
schemeCorner.CornerRadius = UDim.new(0, 8)
schemeCorner.Parent = schemeInput

local actionRow = Instance.new("Frame")
actionRow.Size = UDim2.new(1, -18, 0, 30)
actionRow.Position = UDim2.new(0, 9, 0, 182)
actionRow.BackgroundTransparency = 1
actionRow.Parent = connectionCard

local reconnectButton = Instance.new("TextButton")
reconnectButton.Size = UDim2.new(0.34, -6, 1, 0)
reconnectButton.Position = UDim2.new(0, 0, 0, 0)
reconnectButton.Text = "Reconnect"
reconnectButton.Parent = actionRow
styleButton(reconnectButton, COLORS.primary)
insetText(reconnectButton, 10, 10)

local pingButton = Instance.new("TextButton")
pingButton.Size = UDim2.new(0.33, -6, 1, 0)
pingButton.Position = UDim2.new(0.34, 3, 0, 0)
pingButton.Text = "Ping"
pingButton.Parent = actionRow
styleButton(pingButton, COLORS.secondary)
insetText(pingButton, 10, 10)

local toggleButton = Instance.new("TextButton")
toggleButton.Size = UDim2.new(0.33, -6, 1, 0)
toggleButton.Position = UDim2.new(0.67, 6, 0, 0)
toggleButton.Text = "Bridge: ON"
toggleButton.Parent = actionRow
styleButton(toggleButton, COLORS.success)
insetText(toggleButton, 10, 10)

local diagnosticsCard = Instance.new("Frame")
diagnosticsCard.Size = UDim2.new(1, 0, 0, 210)
diagnosticsCard.Parent = mainPage
styleCard(diagnosticsCard)

local diagnosticsTitle = Instance.new("TextLabel")
diagnosticsTitle.Size = UDim2.new(1, -18, 0, 18)
diagnosticsTitle.Position = UDim2.new(0, 9, 0, 8)
diagnosticsTitle.BackgroundTransparency = 1
diagnosticsTitle.TextColor3 = COLORS.textMain
diagnosticsTitle.TextXAlignment = Enum.TextXAlignment.Left
diagnosticsTitle.Font = Enum.Font.FredokaOne
diagnosticsTitle.TextSize = 12
diagnosticsTitle.Text = "Diagnostics"
diagnosticsTitle.Parent = diagnosticsCard

local diagnosticsToggle = Instance.new("TextButton")
diagnosticsToggle.Size = UDim2.new(0, 156, 0, 24)
diagnosticsToggle.Position = UDim2.new(1, -165, 0, 6)
diagnosticsToggle.Text = "Toggle details"
diagnosticsToggle.Parent = diagnosticsCard
styleButton(diagnosticsToggle, COLORS.secondary)
insetText(diagnosticsToggle, 10, 10)

local errorLabel = Instance.new("TextLabel")
errorLabel.Size = UDim2.new(0.5, -14, 0, 16)
errorLabel.Position = UDim2.new(0, 9, 0, 38)
errorLabel.BackgroundTransparency = 1
errorLabel.TextColor3 = COLORS.danger
errorLabel.TextXAlignment = Enum.TextXAlignment.Left
errorLabel.TextYAlignment = Enum.TextYAlignment.Top
errorLabel.Font = Enum.Font.GothamMedium
errorLabel.TextWrapped = false
errorLabel.TextSize = 11
errorLabel.Text = "Error"
errorLabel.Parent = diagnosticsCard

local errorDetailsBox = Instance.new("TextBox")
errorDetailsBox.Size = UDim2.new(0.5, -14, 0, 92)
errorDetailsBox.Position = UDim2.new(0, 9, 0, 58)
errorDetailsBox.BackgroundColor3 = COLORS.surfaceAlt
errorDetailsBox.TextColor3 = COLORS.textMain
errorDetailsBox.TextXAlignment = Enum.TextXAlignment.Left
errorDetailsBox.TextYAlignment = Enum.TextYAlignment.Top
errorDetailsBox.TextWrapped = true
errorDetailsBox.TextEditable = false
errorDetailsBox.Font = Enum.Font.Code
errorDetailsBox.TextSize = 11
errorDetailsBox.Visible = true
errorDetailsBox.Parent = diagnosticsCard
insetText(errorDetailsBox, 10, 10)
local errDetailCorner = Instance.new("UICorner")
errDetailCorner.CornerRadius = UDim.new(0, 8)
errDetailCorner.Parent = errorDetailsBox

local warningLabel = Instance.new("TextLabel")
warningLabel.Size = UDim2.new(0.5, -14, 0, 16)
warningLabel.Position = UDim2.new(0.5, 5, 0, 38)
warningLabel.BackgroundTransparency = 1
warningLabel.TextColor3 = COLORS.warn
warningLabel.TextXAlignment = Enum.TextXAlignment.Left
warningLabel.TextYAlignment = Enum.TextYAlignment.Top
warningLabel.Font = Enum.Font.GothamMedium
warningLabel.TextWrapped = false
warningLabel.TextSize = 11
warningLabel.Text = "Warning"
warningLabel.Parent = diagnosticsCard

local warningDetailsBox = Instance.new("TextBox")
warningDetailsBox.Size = UDim2.new(0.5, -14, 0, 92)
warningDetailsBox.Position = UDim2.new(0.5, 5, 0, 58)
warningDetailsBox.BackgroundColor3 = COLORS.surfaceAlt
warningDetailsBox.TextColor3 = COLORS.textMain
warningDetailsBox.TextXAlignment = Enum.TextXAlignment.Left
warningDetailsBox.TextYAlignment = Enum.TextYAlignment.Top
warningDetailsBox.TextWrapped = true
warningDetailsBox.TextEditable = false
warningDetailsBox.Font = Enum.Font.Code
warningDetailsBox.TextSize = 11
warningDetailsBox.Visible = true
warningDetailsBox.Parent = diagnosticsCard
insetText(warningDetailsBox, 10, 10)
local warnDetailCorner = Instance.new("UICorner")
warnDetailCorner.CornerRadius = UDim.new(0, 8)
warnDetailCorner.Parent = warningDetailsBox

local clearDiagnosticsButton = Instance.new("TextButton")
clearDiagnosticsButton.Size = UDim2.new(0, 138, 0, 24)
clearDiagnosticsButton.Position = UDim2.new(0, 9, 1, -30)
clearDiagnosticsButton.Text = "Clear diagnostics"
clearDiagnosticsButton.Parent = diagnosticsCard
styleButton(clearDiagnosticsButton, COLORS.secondary)
insetText(clearDiagnosticsButton, 10, 10)

local logCard = Instance.new("Frame")
logCard.Size = UDim2.new(1, 0, 0, 260)
logCard.Parent = mainPage
styleCard(logCard)

local logTitle = Instance.new("TextLabel")
logTitle.Size = UDim2.new(1, -18, 0, 18)
logTitle.Position = UDim2.new(0, 9, 0, 8)
logTitle.BackgroundTransparency = 1
logTitle.TextColor3 = COLORS.textMain
logTitle.TextXAlignment = Enum.TextXAlignment.Left
logTitle.Font = Enum.Font.FredokaOne
logTitle.TextSize = 12
logTitle.Text = "Action log"
logTitle.Parent = logCard

local logCountLabel = Instance.new("TextLabel")
logCountLabel.Size = UDim2.new(0.4, -9, 0, 16)
logCountLabel.Position = UDim2.new(0, 9, 0, 28)
logCountLabel.BackgroundTransparency = 1
logCountLabel.TextColor3 = COLORS.textDim
logCountLabel.TextXAlignment = Enum.TextXAlignment.Left
logCountLabel.Font = Enum.Font.GothamMedium
logCountLabel.TextSize = 10
logCountLabel.Text = "0 entries"
logCountLabel.Parent = logCard

local logDroppedLabel = Instance.new("TextLabel")
logDroppedLabel.Size = UDim2.new(0.6, -9, 0, 16)
logDroppedLabel.Position = UDim2.new(0, 9, 0, 44)
logDroppedLabel.BackgroundTransparency = 1
logDroppedLabel.TextColor3 = COLORS.warn
logDroppedLabel.TextXAlignment = Enum.TextXAlignment.Left
logDroppedLabel.Font = Enum.Font.GothamMedium
logDroppedLabel.TextSize = 10
logDroppedLabel.Text = ""
logDroppedLabel.Visible = false
logDroppedLabel.Parent = logCard

local logToggleButton = Instance.new("TextButton")
logToggleButton.Size = UDim2.new(0, 96, 0, 24)
logToggleButton.Position = UDim2.new(1, -182, 0, 22)
logToggleButton.Text = "Collapse"
logToggleButton.Parent = logCard
styleButton(logToggleButton, COLORS.secondary)
insetText(logToggleButton, 10, 10)

local clearLogButton = Instance.new("TextButton")
clearLogButton.Size = UDim2.new(0, 72, 0, 24)
clearLogButton.Position = UDim2.new(1, -78, 0, 22)
clearLogButton.Text = "Clear"
clearLogButton.Parent = logCard
styleButton(clearLogButton, COLORS.secondary)
insetText(clearLogButton, 10, 10)

local logContainer = Instance.new("Frame")
logContainer.Size = UDim2.new(1, -18, 0, 196)
logContainer.Position = UDim2.new(0, 9, 0, 56)
logContainer.BackgroundTransparency = 1
logContainer.ClipsDescendants = true
logContainer.Parent = logCard

local logScroll = Instance.new("ScrollingFrame")
logScroll.Size = UDim2.fromScale(1, 1)
logScroll.BackgroundColor3 = COLORS.surfaceAlt
logScroll.BorderSizePixel = 0
logScroll.AutomaticCanvasSize = Enum.AutomaticSize.Y
logScroll.CanvasSize = UDim2.new()
logScroll.ScrollBarThickness = 6
logScroll.ScrollBarImageColor3 = COLORS.secondary
logScroll.Parent = logContainer
local logScrollCorner = Instance.new("UICorner")
logScrollCorner.CornerRadius = UDim.new(0, 8)
logScrollCorner.Parent = logScroll

local logListLayout = Instance.new("UIListLayout")
logListLayout.Padding = UDim.new(0, 6)
logListLayout.FillDirection = Enum.FillDirection.Vertical
logListLayout.Parent = logScroll

local logPadding = Instance.new("UIPadding")
logPadding.PaddingLeft = UDim.new(0, 8)
logPadding.PaddingRight = UDim.new(0, 8)
logPadding.PaddingTop = UDim.new(0, 8)
logPadding.PaddingBottom = UDim.new(0, 8)
logPadding.Parent = logScroll

local helperCard = Instance.new("Frame")
helperCard.Size = UDim2.fromScale(1, 1)
helperCard.Parent = helperPage
styleCard(helperCard)

local helperTitle = Instance.new("TextLabel")
helperTitle.Size = UDim2.new(1, -18, 0, 18)
helperTitle.Position = UDim2.new(0, 9, 0, 10)
helperTitle.BackgroundTransparency = 1
helperTitle.TextColor3 = COLORS.textMain
helperTitle.TextXAlignment = Enum.TextXAlignment.Left
helperTitle.Font = Enum.Font.FredokaOne
helperTitle.TextSize = 12
helperTitle.Text = "Server + AI bootstrap"
helperTitle.Parent = helperCard

local helperScroll = Instance.new("ScrollingFrame")
helperScroll.Size = UDim2.new(1, -18, 1, -44)
helperScroll.Position = UDim2.new(0, 9, 0, 36)
helperScroll.BackgroundTransparency = 1
helperScroll.BorderSizePixel = 0
helperScroll.AutomaticCanvasSize = Enum.AutomaticSize.Y
helperScroll.CanvasSize = UDim2.new()
helperScroll.ScrollBarThickness = 6
helperScroll.ScrollBarImageColor3 = COLORS.secondary
helperScroll.Parent = helperCard

local helperScrollLayout = Instance.new("UIListLayout")
helperScrollLayout.FillDirection = Enum.FillDirection.Vertical
helperScrollLayout.Padding = UDim.new(0, 10)
helperScrollLayout.Parent = helperScroll

local helperScrollPadding = Instance.new("UIPadding")
helperScrollPadding.PaddingLeft = UDim.new(0, 2)
helperScrollPadding.PaddingRight = UDim.new(0, 2)
helperScrollPadding.PaddingTop = UDim.new(0, 2)
helperScrollPadding.PaddingBottom = UDim.new(0, 10)
helperScrollPadding.Parent = helperScroll

local serverCommandLabel = Instance.new("TextLabel")
serverCommandLabel.Size = UDim2.new(1, -4, 0, 16)
serverCommandLabel.BackgroundTransparency = 1
serverCommandLabel.TextColor3 = COLORS.textDim
serverCommandLabel.TextXAlignment = Enum.TextXAlignment.Left
serverCommandLabel.Font = Enum.Font.GothamMedium
serverCommandLabel.TextSize = 11
serverCommandLabel.Text = "PowerShell server command"
serverCommandLabel.Parent = helperScroll

local serverCommandBox = Instance.new("TextBox")
serverCommandBox.Size = UDim2.new(1, -4, 0, 90)
serverCommandBox.BackgroundColor3 = COLORS.surfaceAlt
serverCommandBox.TextColor3 = COLORS.textMain
serverCommandBox.TextXAlignment = Enum.TextXAlignment.Left
serverCommandBox.TextYAlignment = Enum.TextYAlignment.Top
serverCommandBox.ClearTextOnFocus = false
serverCommandBox.TextEditable = false
serverCommandBox.MultiLine = true
serverCommandBox.Font = Enum.Font.Code
serverCommandBox.TextSize = 11
serverCommandBox.Parent = helperScroll
insetText(serverCommandBox, 10, 10)
local serverCommandCorner = Instance.new("UICorner")
serverCommandCorner.CornerRadius = UDim.new(0, 8)
serverCommandCorner.Parent = serverCommandBox

local promptHeader = Instance.new("Frame")
promptHeader.Size = UDim2.new(1, -4, 0, 28)
promptHeader.BackgroundTransparency = 1
promptHeader.Parent = helperScroll

local promptLabel = Instance.new("TextLabel")
promptLabel.Size = UDim2.new(0.5, 0, 1, 0)
promptLabel.BackgroundTransparency = 1
promptLabel.TextColor3 = COLORS.textDim
promptLabel.TextXAlignment = Enum.TextXAlignment.Left
promptLabel.Font = Enum.Font.GothamMedium
promptLabel.TextSize = 11
promptLabel.Text = "AI bootstrap prompt"
promptLabel.Parent = promptHeader

local promptRuButton = Instance.new("TextButton")
promptRuButton.Size = UDim2.new(0, 54, 0, 24)
promptRuButton.Position = UDim2.new(1, -116, 0, 2)
promptRuButton.Text = "RU"
promptRuButton.Parent = promptHeader
styleButton(promptRuButton, COLORS.secondary)
insetText(promptRuButton, 8, 8)

local promptEnButton = Instance.new("TextButton")
promptEnButton.Size = UDim2.new(0, 54, 0, 24)
promptEnButton.Position = UDim2.new(1, -56, 0, 2)
promptEnButton.Text = "EN"
promptEnButton.Parent = promptHeader
styleButton(promptEnButton, COLORS.surfaceElevated)
insetText(promptEnButton, 8, 8)

local promptBox = Instance.new("TextBox")
promptBox.Size = UDim2.new(1, -4, 0, 250)
promptBox.BackgroundColor3 = COLORS.surfaceAlt
promptBox.TextColor3 = COLORS.textMain
promptBox.TextXAlignment = Enum.TextXAlignment.Left
promptBox.TextYAlignment = Enum.TextYAlignment.Top
promptBox.ClearTextOnFocus = false
promptBox.TextEditable = false
promptBox.MultiLine = true
promptBox.Font = Enum.Font.Code
promptBox.TextSize = 11
promptBox.Parent = helperScroll
insetText(promptBox, 10, 10)
local promptCorner = Instance.new("UICorner")
promptCorner.CornerRadius = UDim.new(0, 8)
promptCorner.Parent = promptBox

local sessionLabel = Instance.new("TextLabel")
sessionLabel.Size = UDim2.new(0.52, -9, 0, 16)
sessionLabel.Position = UDim2.new(0.48, 0, 0, 92)
sessionLabel.BackgroundTransparency = 1
sessionLabel.TextColor3 = COLORS.textDim
sessionLabel.TextXAlignment = Enum.TextXAlignment.Right
sessionLabel.Font = Enum.Font.GothamMedium
sessionLabel.TextSize = 10
sessionLabel.Text = "Session: offline"
sessionLabel.Parent = headerCard

local state = {
	enabled = false,
	sessionId = nil,
	clientId = plugin:GetSetting("rbxmcp_client_id"),
	loopStarted = false,
	lastSync = nil,
	lastError = nil,
	lastErrorAt = nil,
	lastWarning = nil,
	lastWarningAt = nil,
	lastCommandContext = nil,
	connectionState = "idle",
	uiDiagExpanded = (plugin:GetSetting("rbxmcp_ui_diag_expanded") == true),
	uiLogExpanded = (plugin:GetSetting("rbxmcp_ui_log_expanded") ~= false),
	uiAdvancedExpanded = true,
	logEntries = {},
	logDropped = 0,
	logRenderScheduled = false,
	logExpandedMap = {},
	bridgePort = plugin:GetSetting("rbxmcp_bridge_port"),
	bridgeHost = plugin:GetSetting("rbxmcp_bridge_host"),
	bridgeScheme = plugin:GetSetting("rbxmcp_bridge_scheme"),
	bridgeBaseUrl = plugin:GetSetting("rbxmcp_bridge_url") or DEFAULT_BRIDGE_URL,
	playState = "stopped",
	playMode = nil,
	playSessionId = nil,
	runtimeLogBuffer = {},
	logCaptureAvailable = true,
	httpDisabledNoticeShown = false,
	playBridgeSuppressedNoticeShown = false,
	requestBackoffUntil = 0,
	lastRateLimitAt = 0,
	lastErrorSignature = nil,
	lastErrorSignatureAt = 0,
	projectProfileKey = nil,
	projectProfiles = {},
	activePage = "main",
	helperLanguage = "RU",
}

if type(state.clientId) ~= "string" or state.clientId == "" then
	state.clientId = HttpService:GenerateGUID(false)
	plugin:SetSetting("rbxmcp_client_id", state.clientId)
end

local function trim(text)
	local value = tostring(text or "")
	value = value:gsub("^%s+", "")
	value = value:gsub("%s+$", "")
	return value
end

local function isPlayDataModel()
	return RunService:IsRunning()
end

local function parseBridgeUrl(raw)
	local value = trim(raw)
	if value == "" then
		value = DEFAULT_BRIDGE_URL
	end
	value = value:gsub("/+$", "")
	if value == LEGACY_BRIDGE_URL or value == "http://127.0.0.1:5000" or value == "http://127.0.0.1:5000/v1" then
		value = DEFAULT_BRIDGE_URL
	end
	if value:match("/v1$") then
		value = value .. "/studio"
	elseif not value:match("/v1/studio$") then
		value = value .. "/v1/studio"
	end
	local scheme, rest = value:match("^(https?)://(.+)$")
	if not scheme then
		scheme = "http"
		rest = value
	end
	local base = rest:gsub("/v1/studio$", "")
	local host, port = base:match("^([^:]+):(%d+)$")
	if not host then
		host = base
	end
	return scheme, host, port
end

local function normalizeScheme(value)
	local s = trim(value):lower()
	if s == "https" then
		return "https"
	end
	return "http"
end

local function normalizeHost(value)
	local host = trim(value):gsub("/.*$", "")
	if host == "" then
		return "127.0.0.1"
	end
	local hostOnly = host:match("^([^:]+):%d+$")
	if hostOnly then
		return hostOnly
	end
	return host
end

local function normalizePort(value)
	local numeric = tonumber(trim(value))
	if not numeric then
		return nil, "Port must be a number (1..65535)"
	end
	local intPort = math.floor(numeric)
	if intPort < 1 or intPort > 65535 then
		return nil, "Port must be in range 1..65535"
	end
	return tostring(intPort), nil
end

local function buildBridgeBaseUrl(scheme, host, port)
	return string.format("%s://%s:%s/v1/studio", normalizeScheme(scheme), normalizeHost(host), tostring(port))
end

local function currentProjectProfileKey()
	local placeId = tonumber(game.PlaceId) or 0
	if placeId > 0 then
		return "place:" .. tostring(placeId)
	end
	return "place:unsaved"
end

local function loadProjectProfiles()
	local raw = plugin:GetSetting(PROJECT_PROFILES_KEY)
	if type(raw) == "table" then
		return raw
	end
	if type(raw) ~= "string" or raw == "" then
		return {}
	end
	local okDecode, decoded = pcall(function()
		return HttpService:JSONDecode(raw)
	end)
	if okDecode and type(decoded) == "table" then
		return decoded
	end
	return {}
end

local function saveProjectProfiles()
	local okEncode, encoded = pcall(function()
		return HttpService:JSONEncode(state.projectProfiles or {})
	end)
	if okEncode and type(encoded) == "string" then
		plugin:SetSetting(PROJECT_PROFILES_KEY, encoded)
	end
end
local function persistBridgeSettings()
	state.projectProfiles = state.projectProfiles or {}
	state.projectProfileKey = state.projectProfileKey or currentProjectProfileKey()
	state.projectProfiles[state.projectProfileKey] = {
		port = state.bridgePort,
		host = state.bridgeHost,
		scheme = state.bridgeScheme,
	}
	saveProjectProfiles()
	plugin:SetSetting("rbxmcp_bridge_port", state.bridgePort)
	plugin:SetSetting("rbxmcp_bridge_host", state.bridgeHost)
	plugin:SetSetting("rbxmcp_bridge_scheme", state.bridgeScheme)
	plugin:SetSetting("rbxmcp_bridge_url", state.bridgeBaseUrl)
end

do
	state.projectProfileKey = currentProjectProfileKey()
	state.projectProfiles = loadProjectProfiles()
	local profile = state.projectProfiles[state.projectProfileKey]
	local legacyScheme, legacyHost, legacyPort = parseBridgeUrl(state.bridgeBaseUrl)
	if type(profile) == "table" then
		state.bridgeScheme = normalizeScheme(profile.scheme or state.bridgeScheme or legacyScheme)
		state.bridgeHost = normalizeHost(profile.host or state.bridgeHost or legacyHost)
		local profilePort, _ = normalizePort(profile.port or state.bridgePort or legacyPort or "5100")
		state.bridgePort = profilePort or "5100"
	else
		state.bridgeScheme = normalizeScheme(state.bridgeScheme or legacyScheme)
		state.bridgeHost = normalizeHost(state.bridgeHost or legacyHost)
		local legacyNormalizedPort, _ = normalizePort(state.bridgePort or legacyPort or "5100")
		state.bridgePort = legacyNormalizedPort or "5100"
	end
	state.bridgeBaseUrl = buildBridgeBaseUrl(state.bridgeScheme, state.bridgeHost, state.bridgePort)
	persistBridgeSettings()
end

local function sourceHash(text)
	local hash = 2166136261
	for i = 1, #text do
		hash = bit32.bxor(hash, string.byte(text, i))
		hash = (hash * 16777619) % 4294967296
	end
	return string.format("%08x", hash)
end

local function safeMember(target, memberName)
	if not target then
		return nil
	end
	local okMember, value = pcall(function()
		return target[memberName]
	end)
	if not okMember then
		return nil
	end
	return value
end

local function safeMethod(target, memberName)
	local member = safeMember(target, memberName)
	if type(member) == "function" then
		return member
	end
	return nil
end

local function callMethod(target, memberName, ...)
	local method = safeMethod(target, memberName)
	if not method then
		return false, memberName .. " is unavailable"
	end
	return pcall(method, target, ...)
end

local BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

local function base64EncodeFallback(data)
	data = tostring(data or "")
	local bitString = data:gsub(".", function(char)
		local byte = string.byte(char)
		local bits = ""
		for i = 8, 1, -1 do
			bits = bits .. (((byte % (2 ^ i) - byte % (2 ^ (i - 1))) > 0) and "1" or "0")
		end
		return bits
	end)
	bitString = bitString .. "0000"

	local encoded = bitString:gsub("%d%d%d?%d?%d?%d?", function(chunk)
		if #chunk < 6 then
			return ""
		end
		local value = 0
		for i = 1, 6 do
			if chunk:sub(i, i) == "1" then
				value = value + 2 ^ (6 - i)
			end
		end
		return BASE64_CHARS:sub(value + 1, value + 1)
	end)

	local pad = ({ "", "==", "=" })[(#data % 3) + 1]
	return encoded .. pad
end

local function base64DecodeFallback(data)
	if type(data) ~= "string" then
		return nil, "invalid_base64", "base64 payload is not a string"
	end
	data = data:gsub("[^" .. BASE64_CHARS .. "=]", "")

	local bitString = data:gsub(".", function(char)
		if char == "=" then
			return ""
		end
		local idx = BASE64_CHARS:find(char, 1, true)
		if not idx then
			return ""
		end
		local value = idx - 1
		local bits = ""
		for i = 6, 1, -1 do
			bits = bits .. (((value % (2 ^ i) - value % (2 ^ (i - 1))) > 0) and "1" or "0")
		end
		return bits
	end)

	local decoded = bitString:gsub("%d%d%d?%d?%d?%d?%d?%d?", function(chunk)
		if #chunk ~= 8 then
			return ""
		end
		local value = 0
		for i = 1, 8 do
			if chunk:sub(i, i) == "1" then
				value = value + 2 ^ (8 - i)
			end
		end
		return string.char(value)
	end)
	return decoded, nil, nil
end

local function encodeBase64Utf8(text)
	text = tostring(text or "")
	local base64Encode = safeMethod(HttpService, "Base64Encode")
	if base64Encode then
		local okEncode, encoded = pcall(base64Encode, HttpService, text)
		if okEncode and type(encoded) == "string" then
			return encoded, nil, nil
		end
	end
	return base64EncodeFallback(text), nil, nil
end

local function decodeBase64Utf8(encoded)
	if type(encoded) ~= "string" or encoded == "" then
		return nil, "invalid_base64", "base64 payload is empty"
	end
	local base64Decode = safeMethod(HttpService, "Base64Decode")
	if base64Decode then
		local okDecode, decoded = pcall(base64Decode, HttpService, encoded)
		if okDecode and type(decoded) == "string" then
			return decoded, nil, nil
		end
	end
	return base64DecodeFallback(encoded)
end

local function getOpenDocumentForScript(scriptInstance)
	local getDocs = safeMethod(ScriptEditorService, "GetScriptDocuments")
	if not getDocs then
		return nil
	end
	local okDocs, docs = pcall(getDocs, ScriptEditorService)
	if not okDocs or type(docs) ~= "table" then
		return nil
	end
	for _, doc in ipairs(docs) do
		local getScript = safeMethod(doc, "GetScript")
		local okGet, docScript
		if getScript then
			okGet, docScript = pcall(getScript, doc)
		else
			docScript = safeMember(doc, "Script")
			okGet = docScript ~= nil
		end
		if okGet and docScript == scriptInstance then
			return doc
		end
	end
	return nil
end

local DraftAccess = {
	READ_CHANNEL = "editor",
	WRITE_CHANNEL = "editor",
	WRITE_MODE = "draft_only",
}

function DraftAccess.editorApiAvailable()
	return safeMethod(ScriptEditorService, "GetEditorSource")
		and safeMethod(ScriptEditorService, "UpdateSourceAsync")
		and safeMethod(ScriptEditorService, "OpenScriptDocumentAsync")
end

function DraftAccess.openDocument(scriptInstance)
	local openDoc = safeMethod(ScriptEditorService, "OpenScriptDocumentAsync")
	if not openDoc then
		return false, "editor_api_unavailable", "OpenScriptDocumentAsync is unavailable"
	end
	local okOpen, firstResult, secondResult = pcall(openDoc, ScriptEditorService, scriptInstance)
	if not okOpen then
		return false, "draft_unavailable", tostring(firstResult)
	end
	if type(firstResult) == "boolean" and firstResult == false then
		return false, "draft_unavailable", tostring(secondResult or "OpenScriptDocumentAsync returned false")
	end
	return true, nil, nil
end

function DraftAccess.closeDocument(doc)
	if not doc then
		return nil, nil
	end
	local okClose, closeErr = callMethod(doc, "CloseAsync")
	if not okClose then
		return "draft_close_failed", tostring(closeErr)
	end
	return nil, nil
end

function DraftAccess.getEditorSourceRaw(scriptInstance)
	local getEditorSource = safeMethod(ScriptEditorService, "GetEditorSource")
	if not getEditorSource then
		return nil, "editor_api_unavailable", "GetEditorSource is unavailable"
	end
	local okSource, sourceOrErr = pcall(getEditorSource, ScriptEditorService, scriptInstance)
	if not okSource then
		return nil, "draft_unavailable", tostring(sourceOrErr)
	end
	if type(sourceOrErr) ~= "string" then
		return nil, "draft_unavailable", "GetEditorSource returned non-string"
	end
	return sourceOrErr, nil, nil
end

function DraftAccess.readSource(scriptInstance)
	if not DraftAccess.editorApiAvailable() then
		return nil, "editor_api_unavailable", "ScriptEditorService draft APIs are unavailable"
	end
	local source, readCode, readMessage = DraftAccess.getEditorSourceRaw(scriptInstance)
	if not source then
		return nil, readCode, readMessage
	end
	return source, nil, nil, DraftAccess.READ_CHANNEL, true
end

function DraftAccess.writeSource(scriptInstance, newSource)
	newSource = tostring(newSource or "")
	if not DraftAccess.editorApiAvailable() then
		return false, "editor_api_unavailable", "ScriptEditorService draft APIs are unavailable"
	end

	local existingDoc = getOpenDocumentForScript(scriptInstance)
	local openedByPlugin = false
	if not existingDoc then
		local okOpen, openCode, openMessage = DraftAccess.openDocument(scriptInstance)
		if not okOpen then
			return false, openCode, openMessage
		end
		openedByPlugin = true
		existingDoc = getOpenDocumentForScript(scriptInstance)
	end

	local updateSourceAsync = safeMethod(ScriptEditorService, "UpdateSourceAsync")
	if not updateSourceAsync then
		return false, "editor_api_unavailable", "UpdateSourceAsync is unavailable"
	end
	local okUpdate, updateError = pcall(updateSourceAsync, ScriptEditorService, scriptInstance, function(_oldSource)
			return newSource
		end)
	if not okUpdate then
		if openedByPlugin then
			local warnCode, warnMessage = DraftAccess.closeDocument(existingDoc)
			if warnCode and warnMessage then
				return false, "draft_write_failed", tostring(updateError) .. " (close warning: " .. warnMessage .. ")"
			end
		end
		return false, "draft_write_failed", tostring(updateError)
	end

	local verifySource, verifyCode, verifyMessage = DraftAccess.getEditorSourceRaw(scriptInstance)
	if openedByPlugin then
		local warnCode, warnMessage = DraftAccess.closeDocument(existingDoc)
		if warnCode then
			if not verifySource then
				return false, verifyCode, verifyMessage
			end
			if verifySource ~= newSource then
				return false, "draft_write_failed", "Source verification mismatch after UpdateSourceAsync"
			end
			return true, nil, nil, DraftAccess.WRITE_CHANNEL, warnCode, warnMessage
		end
	end
	if not verifySource then
		return false, verifyCode, verifyMessage
	end
	if verifySource ~= newSource then
		return false, "draft_write_failed", "Source verification mismatch after UpdateSourceAsync"
	end

	return true, nil, nil, DraftAccess.WRITE_CHANNEL, nil, nil
end

local function buildDiagnosticCopy(kind, message, at)
	local ctx = state.lastCommandContext
	local lines = {
		string.format("[%s] %s", kind, tostring(at or nowIso())),
		tostring(message or "-"),
	}
	if type(ctx) == "table" then
		table.insert(lines, "")
		table.insert(lines, "Context:")
		if ctx.command then
			table.insert(lines, "  command: " .. tostring(ctx.command))
		end
		if ctx.endpoint then
			table.insert(lines, "  endpoint: " .. tostring(ctx.endpoint))
		end
		if ctx.path then
			table.insert(lines, "  path: " .. tostring(ctx.path))
		end
	end
	return table.concat(lines, "\n")
end

local function buildServerCommandText()
	local placeId = tostring(tonumber(game.PlaceId) or 0)
	return table.concat({
		"cd <path-to-rbxmcp>",
		string.format('$env:RBXMCP_PORT="%s"', tostring(state.bridgePort or "5100")),
		string.format('$env:RBXMCP_EXPECT_PLACE_ID="%s"', placeId),
		"npm.cmd run dev",
	}, "\n")
end

local function buildAgentPrompt(language)
	local baseUrl = tostring(state.bridgeBaseUrl or DEFAULT_BRIDGE_URL):gsub("/v1/studio$", "")
	if language == "EN" then
		return table.concat({
			string.format("Work only through RBXMCP at %s.", baseUrl),
			"Start with GET /v1/agent/capabilities and follow the returned contracts exactly.",
			"Then call POST /v1/agent/health and show the active placeId/placeName.",
			"Before editing scripts, call get_script with forceRefresh=true and use only hash-locked updates.",
			"Before editing UI, call get_ui_tree with forceRefresh=true and use version-locked UI mutations.",
			"Use retrieval tools before brute-force reading: get_project_summary, find_entrypoints, rank_files_by_relevance, get_related_context.",
			"If an API call fails, show the exact error code first and then use explain_error or the recovery hint from the response.",
			"Do not invent endpoints, do not brute-force payloads, and work only inside the active project on this port.",
		}, "\n")
	end
	return table.concat({
		string.format("Работай только через RBXMCP на %s.", baseUrl),
		"Сначала вызови GET /v1/agent/capabilities и строго следуй contracts из ответа.",
		"Потом вызови POST /v1/agent/health и покажи active placeId/placeName.",
		"Перед правкой скриптов делай get_script с forceRefresh=true и используй только hash-locked update.",
		"Перед правкой UI делай get_ui_tree с forceRefresh=true и используй только version-locked UI mutations.",
		"Для навигации сначала используй retrieval: get_project_summary, find_entrypoints, rank_files_by_relevance, get_related_context.",
		"Если API вернул ошибку, сначала покажи точный error code, потом используй explain_error или recovery hint из ответа.",
		"Не выдумывай endpoint-ы, не подбирай payload brute force и работай только в активном проекте этого порта.",
	}, "\n")
end

local function updateHelperUi()
	quickStartButton.Text = state.activePage == "helper" and "Back" or "Quick Start"
	serverCommandBox.Text = buildServerCommandText()
	promptBox.Text = buildAgentPrompt(state.helperLanguage)
	promptRuButton.BackgroundColor3 = state.helperLanguage == "RU" and COLORS.primary or COLORS.surfaceElevated
	promptEnButton.BackgroundColor3 = state.helperLanguage == "EN" and COLORS.primary or COLORS.surfaceElevated
end

local function setActivePage(pageName)
	state.activePage = pageName == "helper" and "helper" or "main"
	updateHelperUi()
	local targetMain = state.activePage == "main" and UDim2.fromScale(0, 0) or UDim2.fromScale(-1, 0)
	local targetHelper = state.activePage == "helper" and UDim2.fromScale(0, 0) or UDim2.fromScale(1, 0)
	tween(mainPage, TweenInfo.new(0.2, Enum.EasingStyle.Quart, Enum.EasingDirection.Out), { Position = targetMain })
	tween(helperPage, TweenInfo.new(0.2, Enum.EasingStyle.Quart, Enum.EasingDirection.Out), { Position = targetHelper })
end

local renderLogEntries

local function shouldLogEvent(level, category, title)
	if level == "error" or level == "warn" then
		return true
	end
	local key = string.format("%s|%s|%s", tostring(level), tostring(category), tostring(title))
	local suppressed = {
		["info|connection|HTTP ok"] = true,
		["info|connection|Sync"] = true,
		["info|poll|Command received"] = true,
		["info|poll|commands received"] = true,
		["info|ui|Log cleared"] = true,
		["info|ui|Diagnostics cleared"] = true,
	}
	return suppressed[key] ~= true
end

local function scheduleLogRender()
	if state.logRenderScheduled then
		return
	end
	state.logRenderScheduled = true
	task.delay(LOG_RENDER_THROTTLE, function()
		state.logRenderScheduled = false
		renderLogEntries()
	end)
end

renderLogEntries = function()
	for _, child in ipairs(logScroll:GetChildren()) do
		if child:IsA("Frame") then
			child:Destroy()
		end
	end

	local visualIndex = 0
	for index = #state.logEntries, 1, -1 do
		local item = state.logEntries[index]
		local expanded = state.logExpandedMap[index] == true
		visualIndex = visualIndex + 1

		local row = Instance.new("Frame")
		row.Size = UDim2.new(1, 0, 0, expanded and 82 or 30)
		row.BackgroundColor3 = (visualIndex % 2 == 0) and COLORS.surface or COLORS.surfaceAlt
		row.BackgroundTransparency = visualIndex == 1 and 0.16 or 0
		row.BorderSizePixel = 0
		row.Parent = logScroll
		local rowCorner = Instance.new("UICorner")
		rowCorner.CornerRadius = UDim.new(0, 6)
		rowCorner.Parent = row
		if visualIndex == 1 then
			tween(row, TweenInfo.new(0.18, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {
				BackgroundTransparency = 0,
			})
		end

		local tint = COLORS.info
		if item.level == "warn" then
			tint = COLORS.warn
		elseif item.level == "error" then
			tint = COLORS.danger
		end

		local stripe = Instance.new("Frame")
		stripe.Size = UDim2.new(0, 3, 1, 0)
		stripe.BackgroundColor3 = tint
		stripe.BorderSizePixel = 0
		stripe.Parent = row

		local timestamp = Instance.new("TextBox")
		timestamp.Size = UDim2.new(0, 112, 0, 18)
		timestamp.Position = UDim2.new(0, 12, 0, 6)
		timestamp.BackgroundTransparency = 1
		timestamp.Font = Enum.Font.Code
		timestamp.TextSize = 9
		timestamp.TextColor3 = COLORS.textMuted
		timestamp.TextXAlignment = Enum.TextXAlignment.Left
		timestamp.ClearTextOnFocus = false
		timestamp.TextEditable = false
		timestamp.Text = tostring(item.time)
		timestamp.Parent = row

		local header = Instance.new("TextBox")
		header.Size = UDim2.new(1, -206, 0, 18)
		header.Position = UDim2.new(0, 126, 0, 6)
		header.BackgroundTransparency = 1
		header.Font = Enum.Font.GothamMedium
		header.TextSize = 10
		header.TextColor3 = COLORS.textMain
		header.TextXAlignment = Enum.TextXAlignment.Left
		header.ClearTextOnFocus = false
		header.TextEditable = false
		header.Text = string.format("[%s] %s", item.category, item.title)
		header.Parent = row

		local expand = Instance.new("TextButton")
		expand.Size = UDim2.new(0, 74, 0, 20)
		expand.Position = UDim2.new(1, -78, 0, 5)
		expand.Text = expanded and "Less" or "More"
		expand.Parent = row
		styleButton(expand, COLORS.secondary)
		insetText(expand, 8, 8)
		expand.MouseButton1Click:Connect(function()
			state.logExpandedMap[index] = not expanded
			renderLogEntries()
		end)

		if expanded then
			local detailsBox = Instance.new("TextBox")
			detailsBox.Size = UDim2.new(1, -24, 0, 46)
			detailsBox.Position = UDim2.new(0, 12, 0, 30)
			detailsBox.BackgroundTransparency = 1
			detailsBox.Font = Enum.Font.Code
			detailsBox.TextSize = 10
			detailsBox.TextWrapped = true
			detailsBox.TextYAlignment = Enum.TextYAlignment.Top
			detailsBox.TextXAlignment = Enum.TextXAlignment.Left
			detailsBox.TextColor3 = COLORS.textDim
			detailsBox.ClearTextOnFocus = false
			detailsBox.TextEditable = false
			detailsBox.Text = item.details ~= "" and item.details or "(no details)"
			detailsBox.Parent = row
		end
	end

	logCountLabel.Text = string.format("%d entries", #state.logEntries)
	logDroppedLabel.Visible = state.logDropped > 0
	logDroppedLabel.Text = state.logDropped > 0 and string.format("Dropped: %d", state.logDropped) or ""
end

local function addLog(level, category, title, details)
	if not shouldLogEvent(level, category, title) then
		return
	end

	local entry = {
		time = nowIso(),
		level = tostring(level or "info"),
		category = tostring(category or "ui"),
		title = shortText(title, 160),
		details = tostring(details or ""),
	}
	table.insert(state.logEntries, entry)
	if #state.logEntries > LOG_LIMIT then
		table.remove(state.logEntries, 1)
		state.logDropped = state.logDropped + 1
	end
	animateHeroIcon()
	scheduleLogRender()
end

local function emitOutput(level, message)
	if tostring(level or "info") ~= "error" then
		return
	end
	local prefix = string.format("[Aether MCP Bridge][%s] ", tostring(level or "info"):upper())
	pcall(function()
		warn(prefix .. tostring(message or ""))
	end)
end

local updateUi

local function safeUpdateUi()
	local okUi, uiErr = pcall(updateUi)
	if not okUi then
		emitOutput("error", "updateUi failed: " .. tostring(uiErr))
	end
end

local function applyConnectionState(kind)
	state.connectionState = kind
	local color = COLORS.secondary
	local text = "IDLE"
	if kind == "online" then
		color = COLORS.success
		text = "ONLINE"
	elseif kind == "error" then
		color = COLORS.danger
		text = "ERROR"
	elseif kind == "connecting" then
		color = COLORS.accent
		text = "CONNECTING"
	end
	tween(statusBadge, TweenInfo.new(0.16, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { BackgroundColor3 = color })
	statusBadge.Text = text
end

local function updateResponsiveLayout()
	local width = math.max(360, widget.AbsoluteSize.X)
	local height = math.max(260, widget.AbsoluteSize.Y)
	local narrow = width < 430
	local topPadding = 24
	local bodyGap = 10
	local baseHeaderHeight = narrow and 144 or 128
	local baseConnectionHeight = narrow and 258 or 224
	local diagnosticsHeight = state.uiDiagExpanded and (narrow and 224 or 192) or (narrow and 186 or 154)
	local minimumLogHeight = state.uiLogExpanded and 150 or 68
	local bodyHeight = math.max(120, height - topPadding - baseHeaderHeight - bodyGap)
	local remainingLogHeight = bodyHeight - 20 - baseConnectionHeight - diagnosticsHeight
	local logHeight = state.uiLogExpanded and math.max(minimumLogHeight, remainingLogHeight) or minimumLogHeight
	local cardWidth = UDim2.new(1, 0, 0, 0)

	headerCard.Size = UDim2.new(cardWidth.X.Scale, cardWidth.X.Offset, 0, baseHeaderHeight)
	bodyFrame.Size = UDim2.new(1, 0, 0, bodyHeight)
	title.Size = UDim2.new(1, -230, 0, narrow and 48 or 26)
	title.TextWrapped = narrow
	quickStartButton.Position = UDim2.new(1, -118, 0, 12)
	creditLabel.Position = UDim2.new(0, 96, 0, narrow and 62 or 44)
	statusBadge.Position = UDim2.new(0, 96, 0, narrow and 88 or 68)
	statusLabel.Position = UDim2.new(0, 9, 0, baseHeaderHeight - 36)
	syncLabel.Position = UDim2.new(0, 9, 0, baseHeaderHeight - 22)
	sessionLabel.Size = UDim2.new(0.42, -9, 0, 16)
	sessionLabel.Position = UDim2.new(0.58, 0, 0, baseHeaderHeight - 36)

	connectionCard.Size = UDim2.new(cardWidth.X.Scale, cardWidth.X.Offset, 0, baseConnectionHeight)
	advancedToggleButton.Visible = false
	advancedFrame.Position = UDim2.new(0, 9, 0, 148)
	if narrow then
		hostInput.Size = UDim2.new(1, 0, 0, 30)
		hostInput.Position = UDim2.new(0, 0, 0, 0)
		schemeInput.Size = UDim2.new(1, 0, 0, 30)
		schemeInput.Position = UDim2.new(0, 0, 0, 36)
		actionRow.Size = UDim2.new(1, -18, 0, 66)
		reconnectButton.Size = UDim2.new(0.5, -3, 0, 30)
		reconnectButton.Position = UDim2.new(0, 0, 0, 0)
		pingButton.Size = UDim2.new(0.5, -3, 0, 30)
		pingButton.Position = UDim2.new(0.5, 3, 0, 0)
		toggleButton.Size = UDim2.new(1, 0, 0, 30)
		toggleButton.Position = UDim2.new(0, 0, 0, 36)
	else
		hostInput.Size = UDim2.new(0.68, -4, 0, 30)
		hostInput.Position = UDim2.new(0, 0, 0, 0)
		schemeInput.Size = UDim2.new(0.32, -2, 0, 30)
		schemeInput.Position = UDim2.new(0.68, 6, 0, 0)
		actionRow.Size = UDim2.new(1, -18, 0, 30)
		reconnectButton.Size = UDim2.new(0.34, -6, 1, 0)
		reconnectButton.Position = UDim2.new(0, 0, 0, 0)
		pingButton.Size = UDim2.new(0.33, -6, 1, 0)
		pingButton.Position = UDim2.new(0.34, 3, 0, 0)
		toggleButton.Size = UDim2.new(0.33, -6, 1, 0)
		toggleButton.Position = UDim2.new(0.67, 6, 0, 0)
	end
	advancedFrame.Size = UDim2.new(1, -18, 0, narrow and 66 or 32)
	actionRow.Position = UDim2.new(0, 9, 0, narrow and 220 or 186)

	diagnosticsCard.Size = UDim2.new(cardWidth.X.Scale, cardWidth.X.Offset, 0, diagnosticsHeight)
	diagnosticsToggle.Position = UDim2.new(1, -165, 0, 6)
	local diagTop = 38
	local diagGap = 10
	local diagInnerWidth = width - 42
	local panelWidth = math.max(120, math.floor((diagInnerWidth - diagGap) / 2))
	local panelHeight = math.max(54, diagnosticsHeight - 96)
	errorLabel.Size = UDim2.new(0, panelWidth, 0, 16)
	errorLabel.Position = UDim2.new(0, 9, 0, diagTop)
	warningLabel.Size = UDim2.new(0, panelWidth, 0, 16)
	warningLabel.Position = UDim2.new(0, 9 + panelWidth + diagGap, 0, diagTop)
	errorDetailsBox.Size = UDim2.new(0, panelWidth, 0, panelHeight)
	errorDetailsBox.Position = UDim2.new(0, 9, 0, diagTop + 20)
	warningDetailsBox.Size = UDim2.new(0, panelWidth, 0, panelHeight)
	warningDetailsBox.Position = UDim2.new(0, 9 + panelWidth + diagGap, 0, diagTop + 20)
	clearDiagnosticsButton.Position = UDim2.new(0, 9, 1, -30)

	logCard.Size = UDim2.new(cardWidth.X.Scale, cardWidth.X.Offset, 0, logHeight)
	logContainer.Size = UDim2.new(1, -18, 1, -64)
	logContainer.Position = UDim2.new(0, 9, 0, 56)
	helperCard.Size = UDim2.fromScale(1, 1)
	helperScroll.Size = UDim2.new(1, -18, 1, -44)
	promptBox.Size = UDim2.new(1, -4, 0, math.max(220, bodyHeight - 220))
end

local function updateAdvancedUi()
	state.uiAdvancedExpanded = true
	advancedFrame.Visible = true
	hostInput.Visible = true
	schemeInput.Visible = true
	advancedToggleButton.Visible = false
end

local function updateDiagnosticsUi()
	errorDetailsBox.Visible = true
	warningDetailsBox.Visible = true
	diagnosticsToggle.Text = state.uiDiagExpanded and "Compact diagnostics" or "Expand diagnostics"
end

local function updateLogUi()
	logContainer.Visible = state.uiLogExpanded
	logToggleButton.Text = state.uiLogExpanded and "Collapse" or "Expand"
end

updateUi = function()
	toggleButton.Text = state.enabled and "Bridge: ON" or "Bridge: OFF"
	toggleButton.BackgroundColor3 = state.enabled and COLORS.success or COLORS.textDim
	statusLabel.Text = state.enabled and "Status: running" or "Status: paused"
	syncLabel.Text = "Last sync: " .. (state.lastSync or "never")
	errorLabel.Text = "Last error: " .. shortText(state.lastError or "-", 180)
	warningLabel.Text = "Last warning: " .. shortText(state.lastWarning or "-", 180)
	sessionLabel.Text = "Session: " .. (state.sessionId or "offline")
	urlInput.Text = state.bridgePort
	hostInput.Text = state.bridgeHost
	schemeInput.Text = state.bridgeScheme
	fullUrlPreview.Text = state.bridgeBaseUrl
	errorDetailsBox.Text = buildDiagnosticCopy("error", state.lastError, state.lastErrorAt)
	warningDetailsBox.Text = buildDiagnosticCopy("warning", state.lastWarning, state.lastWarningAt)
	updateHelperUi()
	updateAdvancedUi()
	updateDiagnosticsUi()
	updateLogUi()
	updateResponsiveLayout()
	if state.connectionState == "online" then
		applyConnectionState("online")
	elseif state.connectionState == "error" then
		applyConnectionState("error")
	else
		applyConnectionState("idle")
	end
end

local function setError(message)
	local text = tostring(message)
	local signature = text
	local now = os.clock()
	if state.lastErrorSignature == signature and (now - (state.lastErrorSignatureAt or 0)) < 4 then
		state.lastError = text
		state.lastErrorAt = nowIso()
		state.connectionState = "error"
		safeUpdateUi()
		return
	end
	state.lastErrorSignature = signature
	state.lastErrorSignatureAt = now
	state.lastError = text
	state.lastErrorAt = nowIso()
	state.connectionState = "error"
	emitOutput("error", state.lastError)
	local okLog, logErr = pcall(addLog, "error", "connection", "Error", state.lastError)
	if not okLog then
		emitOutput("error", "addLog failed inside setError: " .. tostring(logErr))
	end
	safeUpdateUi()
end

local function setWarning(message)
	state.lastWarning = tostring(message)
	state.lastWarningAt = nowIso()
	emitOutput("warn", state.lastWarning)
	local okLog, logErr = pcall(addLog, "warn", "connection", "Warning", state.lastWarning)
	if not okLog then
		emitOutput("error", "addLog failed inside setWarning: " .. tostring(logErr))
	end
	safeUpdateUi()
end

local function clearWarning()
	state.lastWarning = nil
	state.lastWarningAt = nil
	safeUpdateUi()
end

local function setSyncNow()
	state.lastSync = nowIso()
	addLog("info", "connection", "Sync", state.lastSync)
	safeUpdateUi()
end

local function isRequestLimitMessage(message)
	local text = tostring(message or "")
	return string.find(text, "Number of requests exceeded limit", 1, true) ~= nil
end

local function activateRequestBackoff(message)
	local now = os.clock()
	local nextUntil = now + 6
	if nextUntil > (state.requestBackoffUntil or 0) then
		state.requestBackoffUntil = nextUntil
	end
	if (now - (state.lastRateLimitAt or 0)) >= 8 then
		state.lastRateLimitAt = now
		setError(tostring(message or "Request rate limit exceeded"))
	end
end

local function requestJson(path, payload)
	state.lastCommandContext = {
		endpoint = path,
	}
	if (state.requestBackoffUntil or 0) > os.clock() then
		return false, "Request backoff active after Studio HTTP rate limit"
	end
	local okReq, response = pcall(function()
		return HttpService:RequestAsync({
			Url = state.bridgeBaseUrl .. path,
			Method = "POST",
			Headers = {
				["Content-Type"] = "application/json",
			},
			Body = HttpService:JSONEncode(payload),
		})
	end)
	if not okReq then
		local requestError = tostring(response)
		if isRequestLimitMessage(requestError) then
			activateRequestBackoff("Studio HTTP request limit reached")
		else
			emitOutput("error", string.format("requestJson failed for %s -> %s", path, requestError))
			addLog("error", "connection", "HTTP request failed", string.format("%s -> %s", path, requestError))
		end
		return false, "Request failed: " .. requestError
	end
	if not response.Success then
		state.lastCommandContext.statusCode = response.StatusCode
		local bodyText = tostring(response.Body)
		if isRequestLimitMessage(bodyText) then
			activateRequestBackoff("Studio HTTP request limit reached")
		else
			emitOutput("error", string.format("HTTP %s on %s -> %s", tostring(response.StatusCode), path, bodyText))
			addLog(
				"error",
				"connection",
				"HTTP error",
				string.format("%s -> %s %s", path, tostring(response.StatusCode), bodyText)
			)
		end
		return false, "HTTP " .. tostring(response.StatusCode) .. ": " .. bodyText
	end
	state.requestBackoffUntil = 0
	local ok, decoded = pcall(function()
		return HttpService:JSONDecode(response.Body)
	end)
	if not ok then
		emitOutput("error", "Invalid JSON from server on " .. tostring(path))
		addLog("error", "connection", "JSON decode failed", path)
		return false, "Invalid JSON from server"
	end
	return true, decoded
end

local function bridgeRootUrl()
	return state.bridgeBaseUrl:gsub("/v1/studio$", "")
end

local function pingBridge()
	state.lastCommandContext = {
		endpoint = "/healthz",
	}
	local okReq, response = pcall(function()
		return HttpService:RequestAsync({
			Url = bridgeRootUrl() .. "/healthz",
			Method = "GET",
		})
	end)
	if not okReq then
		addLog("error", "connection", "Ping failed", tostring(response))
		return false, "Ping failed: " .. tostring(response)
	end
	if not response.Success then
		addLog("error", "connection", "Ping HTTP error", tostring(response.StatusCode))
		return false, "Ping HTTP " .. tostring(response.StatusCode) .. ": " .. tostring(response.Body)
	end
	addLog("info", "connection", "Ping ok", bridgeRootUrl() .. "/healthz")
	return true, nil
end

local function isLuaScript(instance)
	return instance:IsA("ModuleScript") or instance:IsA("LocalScript") or instance:IsA("Script")
end

local orderedServices = {
	"Workspace",
	"ReplicatedFirst",
	"ReplicatedStorage",
	"ServerScriptService",
	"ServerStorage",
	"StarterPlayer",
	"StarterGui",
	"StarterPack",
}

local function getPathSegments(instance)
	local segments = {}
	local current = instance
	while current and current ~= game do
		table.insert(segments, 1, current.Name)
		current = current.Parent
	end
	return segments
end

local function serializeScript(instance)
	local source, readCode, readMessage, readChannel, draftAware = DraftAccess.readSource(instance)
	if not source then
		return nil, readCode, readMessage
	end
	local sourceBase64 = nil
	local encodedSource, encodeCode, encodeMessage = encodeBase64Utf8(source)
	if encodedSource then
		sourceBase64 = encodedSource
	elseif encodeCode and encodeMessage then
		setWarning(tostring(encodeCode) .. ": " .. tostring(encodeMessage))
	end
	return {
		path = getPathSegments(instance),
		class = instance.ClassName,
		source = source,
		sourceBase64 = sourceBase64,
		hash = sourceHash(source),
		readChannel = readChannel,
		draftAware = draftAware,
	}
end

local function collectAllScripts()
	local scripts = {}
	for _, serviceName in ipairs(orderedServices) do
		local okService, service = pcall(function()
			return game:GetService(serviceName)
		end)
		if okService and service then
			for _, descendant in ipairs(service:GetDescendants()) do
				if isLuaScript(descendant) then
					local scriptPayload, readCode, readMessage = serializeScript(descendant)
					if not scriptPayload then
						return nil, readCode, readMessage
					end
					table.insert(scripts, scriptPayload)
				end
			end
		end
	end
	return scripts
end

local function findByPath(pathSegments)
	if type(pathSegments) ~= "table" or #pathSegments < 2 then
		return nil
	end
	local okService, current = pcall(function()
		return game:GetService(tostring(pathSegments[1]))
	end)
	if not okService or not current then
		return nil
	end
	for i = 2, #pathSegments do
		current = current:FindFirstChild(tostring(pathSegments[i]))
		if not current then
			return nil
		end
	end
	if not isLuaScript(current) then
		return nil
	end
	return current
end

local function collectScriptsByPaths(pathList)
	if type(pathList) ~= "table" then
		return nil, "invalid_paths", "paths must be an array"
	end
	local scripts = {}
	for _, entry in ipairs(pathList) do
		local scriptInstance = findByPath(entry)
		if scriptInstance then
			local scriptPayload, readCode, readMessage = serializeScript(scriptInstance)
			if not scriptPayload then
				return nil, readCode, readMessage
			end
			table.insert(scripts, scriptPayload)
		end
	end
	return scripts, nil, nil
end

local function getOrCreateContainer(parent, name)
	local child = parent:FindFirstChild(name)
	if child then
		return child
	end
	local folder = Instance.new("Folder")
	folder.Name = tostring(name)
	folder.Parent = parent
	return folder
end

local function getOrCreateScriptByPath(pathSegments, className)
	if type(pathSegments) ~= "table" or #pathSegments < 2 then
		return nil, "invalid path"
	end
	local okService, current = pcall(function()
		return game:GetService(tostring(pathSegments[1]))
	end)
	if not okService or not current then
		return nil, "service not found"
	end

	for i = 2, (#pathSegments - 1) do
		current = getOrCreateContainer(current, tostring(pathSegments[i]))
	end

	local scriptName = tostring(pathSegments[#pathSegments])
	local existing = current:FindFirstChild(scriptName)
	if existing then
		if isLuaScript(existing) then
			return existing, nil
		end
		return nil, "path occupied by non-script instance"
	end

	local cls = tostring(className or "LocalScript")
	if cls ~= "Script" and cls ~= "LocalScript" and cls ~= "ModuleScript" then
		cls = "LocalScript"
	end

	local okNew, created = pcall(function()
		return Instance.new(cls)
	end)
	if not okNew or not created then
		return nil, "failed to create script class " .. cls
	end
	created.Name = scriptName
	created.Parent = current
	return created, nil
end

local function findInstanceByPath(pathSegments)
	if type(pathSegments) ~= "table" or #pathSegments < 1 then
		return nil
	end
	local okService, current = pcall(function()
		return game:GetService(tostring(pathSegments[1]))
	end)
	if not okService or not current then
		return nil
	end
	for i = 2, #pathSegments do
		current = current:FindFirstChild(tostring(pathSegments[i]))
		if not current then
			return nil
		end
	end
	return current
end

local function isUiRelevantInstance(instance)
	return instance:IsA("LayerCollector")
		or instance:IsA("GuiObject")
		or instance:IsA("UIBase")
		or instance:IsA("CanvasGroup")
end

local function isUiRootInstance(instance)
	if not instance or not instance:IsA("LayerCollector") then
		return false
	end
	local path = getPathSegments(instance)
	return path[1] ~= "CoreGui"
end

local UI_PROP_NAMES = {
	"Text",
	"PlaceholderText",
	"Image",
	"Visible",
	"Active",
	"LayoutOrder",
	"ZIndex",
	"BackgroundTransparency",
	"TextTransparency",
	"ImageTransparency",
	"TextScaled",
	"TextSize",
	"Rotation",
	"BorderSizePixel",
	"BackgroundColor3",
	"TextColor3",
	"ImageColor3",
	"BorderColor3",
	"AnchorPoint",
	"Position",
	"Size",
	"AutomaticSize",
	"CanvasSize",
	"CanvasPosition",
	"ScrollBarImageColor3",
	"PlaceholderColor3",
	"CornerRadius",
	"Thickness",
	"Color",
	"Transparency",
	"PaddingLeft",
	"PaddingRight",
	"PaddingTop",
	"PaddingBottom",
}

local function encodeUiValue(value)
	local kind = typeof(value)
	if kind == "string" or kind == "number" or kind == "boolean" then
		return value
	end
	if kind == "Color3" then
		return { type = "Color3", r = value.R, g = value.G, b = value.B }
	end
	if kind == "UDim" then
		return { type = "UDim", scale = value.Scale, offset = value.Offset }
	end
	if kind == "UDim2" then
		return {
			type = "UDim2",
			x = { type = "UDim", scale = value.X.Scale, offset = value.X.Offset },
			y = { type = "UDim", scale = value.Y.Scale, offset = value.Y.Offset },
		}
	end
	if kind == "Vector2" then
		return { type = "Vector2", x = value.X, y = value.Y }
	end
	if kind == "EnumItem" then
		return { type = "Enum", enumType = tostring(value.EnumType), value = value.Name }
	end
	if kind == "ColorSequence" then
		local keypoints = {}
		for _, keypoint in ipairs(value.Keypoints) do
			table.insert(keypoints, {
				time = keypoint.Time,
				value = encodeUiValue(keypoint.Value),
			})
		end
		return { type = "ColorSequence", keypoints = keypoints }
	end
	if kind == "NumberSequence" then
		local keypoints = {}
		for _, keypoint in ipairs(value.Keypoints) do
			table.insert(keypoints, {
				time = keypoint.Time,
				value = keypoint.Value,
				envelope = keypoint.Envelope,
			})
		end
		return { type = "NumberSequence", keypoints = keypoints }
	end
	if kind == "Rect" then
		return {
			type = "Rect",
			minX = value.Min.X,
			minY = value.Min.Y,
			maxX = value.Max.X,
			maxY = value.Max.Y,
		}
	end
	return nil
end

local function decodeUiValue(value)
	if type(value) ~= "table" then
		return value
	end
	if value.type == "Color3" then
		return Color3.new(tonumber(value.r) or 0, tonumber(value.g) or 0, tonumber(value.b) or 0)
	end
	if value.type == "UDim" then
		return UDim.new(tonumber(value.scale) or 0, tonumber(value.offset) or 0)
	end
	if value.type == "UDim2" then
		return UDim2.new(
			tonumber(value.x and value.x.scale) or 0,
			tonumber(value.x and value.x.offset) or 0,
			tonumber(value.y and value.y.scale) or 0,
			tonumber(value.y and value.y.offset) or 0
		)
	end
	if value.type == "Vector2" then
		return Vector2.new(tonumber(value.x) or 0, tonumber(value.y) or 0)
	end
	if value.type == "Enum" and type(value.enumType) == "string" and type(value.value) == "string" then
		local enumName = value.enumType:match("Enum%.(.+)$") or value.enumType
		local enumTable = Enum[enumName]
		if enumTable then
			return enumTable[value.value]
		end
	end
	if value.type == "ColorSequence" and type(value.keypoints) == "table" then
		local keypoints = {}
		for _, keypoint in ipairs(value.keypoints) do
			table.insert(keypoints, ColorSequenceKeypoint.new(tonumber(keypoint.time) or 0, decodeUiValue(keypoint.value)))
		end
		return ColorSequence.new(keypoints)
	end
	if value.type == "NumberSequence" and type(value.keypoints) == "table" then
		local keypoints = {}
		for _, keypoint in ipairs(value.keypoints) do
			table.insert(keypoints, NumberSequenceKeypoint.new(tonumber(keypoint.time) or 0, tonumber(keypoint.value) or 0, tonumber(keypoint.envelope) or 0))
		end
		return NumberSequence.new(keypoints)
	end
	if value.type == "Rect" then
		return Rect.new(tonumber(value.minX) or 0, tonumber(value.minY) or 0, tonumber(value.maxX) or 0, tonumber(value.maxY) or 0)
	end
	return nil
end

local function zeroValueFor(currentValue)
	local kind = typeof(currentValue)
	if kind == "string" then
		return ""
	end
	if kind == "number" then
		return 0
	end
	if kind == "boolean" then
		return false
	end
	if kind == "Color3" then
		return Color3.new()
	end
	if kind == "UDim" then
		return UDim.new(0, 0)
	end
	if kind == "UDim2" then
		return UDim2.new(0, 0, 0, 0)
	end
	if kind == "Vector2" then
		return Vector2.new(0, 0)
	end
	if kind == "ColorSequence" then
		return ColorSequence.new(Color3.new())
	end
	if kind == "NumberSequence" then
		return NumberSequence.new(0)
	end
	if kind == "Rect" then
		return Rect.new(0, 0, 0, 0)
	end
	return nil
end

local function serializeUiNode(instance)
	local props = {}
	local unsupported = {}
	for _, propName in ipairs(UI_PROP_NAMES) do
		local okValue, rawValue = pcall(function()
			return instance[propName]
		end)
		if okValue then
			local encoded = encodeUiValue(rawValue)
			if encoded ~= nil then
				props[propName] = encoded
			end
		else
			table.insert(unsupported, propName)
		end
	end
	local children = {}
	for _, child in ipairs(instance:GetChildren()) do
		if isUiRelevantInstance(child) then
			table.insert(children, serializeUiNode(child))
		end
	end
	local path = getPathSegments(instance)
	local canonical = {
		path = path,
		service = path[1],
		name = instance.Name,
		className = instance.ClassName,
		props = props,
		children = children,
	}
	local version = sourceHash(HttpService:JSONEncode(canonical))
	return {
		path = path,
		service = path[1],
		name = instance.Name,
		className = instance.ClassName,
		version = version,
		updatedAt = nowIso(),
		props = props,
		unsupportedProperties = unsupported,
		children = children,
	}
end

local function readBoolProperty(instance, propertyName, fallback)
	local okValue, value = pcall(function()
		return instance[propertyName]
	end)
	if okValue and type(value) == "boolean" then
		return value
	end
	return fallback
end

local function readNumberProperty(instance, propertyName, fallback)
	local okValue, value = pcall(function()
		return instance[propertyName]
	end)
	if okValue and type(value) == "number" then
		return value
	end
	return fallback
end

local function readEncodedProperty(instance, propertyName)
	local okValue, value = pcall(function()
		return instance[propertyName]
	end)
	if not okValue then
		return nil
	end
	return encodeUiValue(value)
end

local function readVector2Pair(instance, propertyName)
	local okValue, value = pcall(function()
		return instance[propertyName]
	end)
	if not okValue or typeof(value) ~= "Vector2" then
		return { x = 0, y = 0 }
	end
	return {
		x = value.X,
		y = value.Y,
	}
end

local function readTextLikeFields(instance)
	local payload = {}
	local okText, text = pcall(function()
		return instance.Text
	end)
	if okText and type(text) == "string" then
		payload.text = text
	end
	local okBounds, bounds = pcall(function()
		return instance.TextBounds
	end)
	if okBounds and typeof(bounds) == "Vector2" then
		payload.textBounds = {
			x = bounds.X,
			y = bounds.Y,
		}
	end
	local okScaled, scaled = pcall(function()
		return instance.TextScaled
	end)
	if okScaled and type(scaled) == "boolean" then
		payload.textScaled = scaled
	end
	local okWrapped, wrapped = pcall(function()
		return instance.TextWrapped
	end)
	if okWrapped and type(wrapped) == "boolean" then
		payload.textWrapped = wrapped
	end
	return payload
end

local function serializeUiLayoutNode(instance)
	local payload = {
		path = getPathSegments(instance),
		className = instance.ClassName,
		visible = readBoolProperty(instance, "Visible", true),
		active = readBoolProperty(instance, "Active", false),
		anchorPoint = readEncodedProperty(instance, "AnchorPoint") or { type = "Vector2", x = 0, y = 0 },
		position = readEncodedProperty(instance, "Position"),
		size = readEncodedProperty(instance, "Size"),
		absolutePosition = readVector2Pair(instance, "AbsolutePosition"),
		absoluteSize = readVector2Pair(instance, "AbsoluteSize"),
		zIndex = readNumberProperty(instance, "ZIndex", 0),
		clipsDescendants = readBoolProperty(instance, "ClipsDescendants", false),
		children = {},
	}
	for key, value in pairs(readTextLikeFields(instance)) do
		payload[key] = value
	end
	for _, child in ipairs(instance:GetChildren()) do
		if isUiRelevantInstance(child) then
			table.insert(payload.children, serializeUiLayoutNode(child))
		end
	end
	return payload
end

local function collectAllUiRoots()
	local roots = {}
	for _, instance in ipairs(game:GetDescendants()) do
		if isUiRootInstance(instance) then
			table.insert(roots, serializeUiNode(instance))
		end
	end
	return roots
end

local function findUiRootForPath(pathSegments)
	local instance = findInstanceByPath(pathSegments)
	while instance do
		if isUiRootInstance(instance) then
			return instance
		end
		instance = instance.Parent
	end
	return nil
end

local function makePathCopy(pathSegments)
	local out = {}
	if type(pathSegments) ~= "table" then
		return out
	end
	for index, segment in ipairs(pathSegments) do
		out[index] = tostring(segment)
	end
	return out
end

local function findUiRootForInstance(instance)
	while instance do
		if isUiRootInstance(instance) then
			return instance
		end
		instance = instance.Parent
	end
	return nil
end

local function resolveUiPath(pathSegments)
	local normalizedPath = makePathCopy(pathSegments)
	local instance = findInstanceByPath(normalizedPath)
	if not instance then
		return nil, "not_found", {
			path = normalizedPath,
		}
	end
	if not isUiRelevantInstance(instance) then
		return nil, "path_blocked_by_non_ui_child", {
			path = normalizedPath,
			blockedPath = normalizedPath,
			blockedClassName = instance.ClassName,
		}
	end
	local root = findUiRootForInstance(instance)
	if not root then
		return nil, "path_blocked_by_non_ui_child", {
			path = normalizedPath,
			blockedPath = normalizedPath,
			blockedClassName = instance.ClassName,
		}
	end
	return {
		instance = instance,
		root = root,
		path = normalizedPath,
	}, nil, nil
end

local function isUiClassSupported(className)
	local okNew, created = pcall(function()
		return Instance.new(tostring(className))
	end)
	if not okNew or not created then
		return false
	end
	local supported = isUiRelevantInstance(created)
	created:Destroy()
	return supported
end
local function pushUiSnapshot(mode, roots)
	return requestJson("/push_ui_snapshot", {
		sessionId = state.sessionId,
		mode = mode,
		roots = roots,
	})
end

local function pushLogs(entries)
	return requestJson("/push_logs", {
		sessionId = state.sessionId,
		entries = entries,
	})
end

local function appendRuntimeLog(level, message, source)
	local entry = {
		id = HttpService:GenerateGUID(false),
		time = nowIso(),
		level = level,
		message = tostring(message or ""),
		source = source,
		playSessionId = state.playSessionId,
	}
	table.insert(state.runtimeLogBuffer, entry)
	if #state.runtimeLogBuffer > 1000 then
		table.remove(state.runtimeLogBuffer, 1)
	end
end

local function flushRuntimeLogs()
	if not state.sessionId or #state.runtimeLogBuffer == 0 then
		return
	end
	local batch = {}
	local count = math.min(#state.runtimeLogBuffer, 100)
	for i = 1, count do
		table.insert(batch, state.runtimeLogBuffer[i])
	end
	local okPush, pushResp = pushLogs(batch)
	if okPush and type(pushResp) == "table" and pushResp.ok == true then
		for _ = 1, count do
			table.remove(state.runtimeLogBuffer, 1)
		end
	end
end

local function uiMutationTargetPath(operation)
	if type(operation) ~= "table" then
		return nil
	end
	if operation.op == "create_node" then
		return operation.parentPath
	end
	return operation.path
end

local function applyUiProps(instance, props, clearProps)
	if type(props) == "table" then
		for propName, encodedValue in pairs(props) do
			local decodedValue = decodeUiValue(encodedValue)
			local okSet, setErr = pcall(function()
				instance[propName] = decodedValue
			end)
			if not okSet then
				return false, "ui_mutation_failed", tostring(setErr)
			end
		end
	end
	if type(clearProps) == "table" then
		for _, propName in ipairs(clearProps) do
			local okRead, currentValue = pcall(function()
				return instance[propName]
			end)
			if okRead then
				local zeroValue = zeroValueFor(currentValue)
				if zeroValue ~= nil then
					local okSet, setErr = pcall(function()
						instance[propName] = zeroValue
					end)
					if not okSet then
						return false, "ui_mutation_failed", tostring(setErr)
					end
				end
			end
		end
	end
	return true, nil, nil
end

local function applyLayoutOrder(instance, index)
	if type(index) ~= "number" then
		return
	end
	pcall(function()
		instance.LayoutOrder = math.floor(index)
	end)
end

local function executeUiOperation(operation)
	if type(operation) ~= "table" or type(operation.op) ~= "string" then
		return false, "invalid_operation", "operation must be a table with op", nil
	end
	if operation.op == "update_props" then
		local resolved, errCode, errDetails = resolveUiPath(operation.path)
		if not resolved then
			return false, errCode or "not_found", "UI node not found", errDetails
		end
		local okApply, applyCode, applyMessage = applyUiProps(resolved.instance, operation.props, operation.clearProps)
		return okApply, applyCode, applyMessage, nil
	end
	if operation.op == "create_node" then
		if not isUiClassSupported(operation.className) then
			return false, "ui_class_not_supported", "Only UI-relevant classes are supported by the UI API", {
				className = tostring(operation.className),
			}
		end
		local resolvedParent, parentErrCode, parentErrDetails = resolveUiPath(operation.parentPath)
		if not resolvedParent then
			return false, parentErrCode or "not_found", "UI parent not found", parentErrDetails
		end
		local parent = resolvedParent.instance
		local existing = parent:FindFirstChild(tostring(operation.name))
		if existing then
			if isUiRelevantInstance(existing) then
				return false, "already_exists", "UI child already exists", {
					path = makePathCopy(operation.parentPath),
					name = tostring(operation.name),
				}
			end
			return false, "name_occupied_by_non_ui_child", "Name is occupied by a non-UI child", {
				path = makePathCopy(operation.parentPath),
				name = tostring(operation.name),
				blockingClassName = existing.ClassName,
			}
		end
		local okNew, created = pcall(function()
			return Instance.new(tostring(operation.className))
		end)
		if not okNew or not created then
			return false, "ui_mutation_failed", "Failed to create UI instance", {
				className = tostring(operation.className),
			}
		end
		created.Name = tostring(operation.name)
		created.Parent = parent
		local okProps, propCode, propMessage = applyUiProps(created, operation.props, operation.clearProps)
		if not okProps then
			created:Destroy()
			return false, propCode, propMessage, nil
		end
		applyLayoutOrder(created, operation.index)
		return true, nil, nil, nil
	end
	if operation.op == "delete_node" then
		local resolved, errCode, errDetails = resolveUiPath(operation.path)
		if not resolved then
			return false, errCode or "not_found", "UI node not found", errDetails
		end
		resolved.instance:Destroy()
		return true, nil, nil, nil
	end
	if operation.op == "move_node" then
		local resolved, errCode, errDetails = resolveUiPath(operation.path)
		if not resolved then
			return false, errCode or "not_found", "UI move target not found", errDetails
		end
		local resolvedParent, parentErrCode, parentErrDetails = resolveUiPath(operation.newParentPath)
		if not resolvedParent then
			return false, parentErrCode or "not_found", "UI move parent not found", parentErrDetails
		end
		resolved.instance.Parent = resolvedParent.instance
		applyLayoutOrder(resolved.instance, operation.index)
		return true, nil, nil, nil
	end
	return false, "unsupported_operation", "Unsupported UI mutation op", nil
end

LogService.MessageOut:Connect(function(message, messageType)
	local level = "info"
	if messageType == Enum.MessageType.MessageWarning then
		level = "warn"
	elseif messageType == Enum.MessageType.MessageError then
		level = "error"
	end
	appendRuntimeLog(level, message, "studio")
end)

local function pushSnapshot(mode, scripts)
	return requestJson("/push_snapshot", {
		sessionId = state.sessionId,
		mode = mode,
		scripts = scripts,
	})
end

local function sendResult(commandId, okResult, resultPayload, errorPayload)
	return requestJson("/result", {
		sessionId = state.sessionId,
		commandId = commandId,
		ok = okResult,
		result = resultPayload,
		error = errorPayload,
	})
end

local function sendInternalCommandError(command, errValue)
	local message = tostring(errValue)
	setError(message)
	addLog("error", "poll", "plugin_internal_error", message)
	if type(command) ~= "table" then
		return
	end
	local commandId = command.commandId
	if type(commandId) ~= "string" or commandId == "" then
		return
	end
	local okSend, sendResp = sendResult(commandId, false, nil, {
		code = "plugin_internal_error",
		message = message,
	})
	if not okSend then
		setError("Failed to send plugin_internal_error: " .. tostring(sendResp))
	end
end

local function decodeIncomingSource(payload)
	if type(payload) ~= "table" then
		return "", nil, nil
	end
	local encoded = payload.newSourceBase64
	if type(encoded) == "string" and encoded ~= "" then
		local decoded, decodeCode, decodeMessage = decodeBase64Utf8(encoded)
		if not decoded then
			setWarning(tostring(decodeCode or "invalid_base64") .. ": " .. tostring(decodeMessage or "Unable to decode newSourceBase64"))
			return tostring(payload.newSource or ""), nil, nil
		end
		return decoded, nil, nil
	end
	return tostring(payload.newSource or ""), nil, nil
end

local function execCommand(command)
	local commandType = command.type
	local payload = command.payload or {}
	state.lastCommandContext = {
		command = tostring(commandType),
		path = type(payload.path) == "table" and table.concat(payload.path, "/") or nil,
	}
	addLog("info", "poll", "Command received", tostring(commandType))
	clearWarning()

	if commandType == "snapshot_all_scripts" then
		local scripts, readCode, readMessage = collectAllScripts()
		if not scripts then
			addLog("error", "snapshot", "snapshot_all failed", tostring(readMessage or readCode))
			sendResult(command.commandId, false, nil, {
				code = readCode or "draft_unavailable",
				message = tostring(readMessage or "Failed to read scripts via draft pipeline"),
			})
			return
		end
		local okPush, pushResp = pushSnapshot("all", scripts)
		if not okPush or pushResp.ok ~= true then
			addLog("error", "snapshot", "snapshot_all push failed", tostring(pushResp))
			sendResult(command.commandId, false, nil, {
				code = "push_failed",
				message = tostring(pushResp),
			})
			return
		end
		sendResult(command.commandId, true, {
			count = #scripts,
		}, nil)
		addLog("info", "snapshot", "snapshot_all ok", string.format("count=%d", #scripts))
		setSyncNow()
		return
	end

	if commandType == "snapshot_script_by_path" then
		local path = payload.path
		local scriptInstance = findByPath(path)
		if not scriptInstance then
			addLog("warn", "snapshot", "snapshot_by_path not_found", tostring(path and table.concat(path, "/") or ""))
			sendResult(command.commandId, false, nil, {
				code = "not_found",
				message = "Script not found for path",
				details = {
					path = path,
				},
			})
			return
		end
		local scriptPayload, readCode, readMessage = serializeScript(scriptInstance)
		if not scriptPayload then
			addLog("error", "snapshot", "snapshot_by_path read failed", tostring(readMessage or readCode))
			sendResult(command.commandId, false, nil, {
				code = readCode or "draft_unavailable",
				message = tostring(readMessage or "Failed to read script via draft pipeline"),
				details = {
					path = path,
				},
			})
			return
		end
		local okPush, pushResp = pushSnapshot("partial", { scriptPayload })
		if not okPush or pushResp.ok ~= true then
			addLog("error", "snapshot", "snapshot_by_path push failed", tostring(pushResp))
			sendResult(command.commandId, false, nil, {
				code = "push_failed",
				message = tostring(pushResp),
			})
			return
		end
		sendResult(command.commandId, true, {
			hash = scriptPayload.hash,
			path = scriptPayload.path,
		}, nil)
		addLog("info", "snapshot", "snapshot_by_path ok", table.concat(scriptPayload.path, "/"))
		setSyncNow()
		return
	end

	if commandType == "snapshot_scripts_by_paths" then
		local scripts, readCode, readMessage = collectScriptsByPaths(payload.paths)
		if not scripts then
			addLog("error", "snapshot", "snapshot_by_paths read failed", tostring(readMessage or readCode))
			sendResult(command.commandId, false, nil, {
				code = readCode or "draft_unavailable",
				message = tostring(readMessage or "Failed to read scripts via draft pipeline"),
			})
			return
		end
		local okPush, pushResp = pushSnapshot("partial", scripts)
		if not okPush or pushResp.ok ~= true then
			addLog("error", "snapshot", "snapshot_by_paths push failed", tostring(pushResp))
			sendResult(command.commandId, false, nil, {
				code = "push_failed",
				message = tostring(pushResp),
			})
			return
		end
		sendResult(command.commandId, true, {
			requested = type(payload.paths) == "table" and #payload.paths or 0,
			found = #scripts,
		}, nil)
		addLog("info", "snapshot", "snapshot_by_paths ok", string.format("found=%d", #scripts))
		setSyncNow()
		return
	end

	if commandType == "snapshot_ui_roots" then
		local roots = collectAllUiRoots()
		local okPush, pushResp = pushUiSnapshot("all", roots)
		if not okPush or pushResp.ok ~= true then
			sendResult(command.commandId, false, nil, {
				code = "push_failed",
				message = tostring(pushResp),
			})
			return
		end
		sendResult(command.commandId, true, {
			count = #roots,
		}, nil)
		addLog("info", "snapshot", "snapshot_ui_roots ok", string.format("count=%d", #roots))
		setSyncNow()
		return
	end

	if commandType == "snapshot_ui_subtree_by_path" then
		local resolved, errCode, errDetails = resolveUiPath(payload.path)
		if not resolved then
			sendResult(command.commandId, false, nil, {
				code = errCode or "not_found",
				message = (errCode == "path_blocked_by_non_ui_child") and "UI path is blocked by a non-UI child" or "UI root not found for path",
				details = errDetails or { path = payload.path },
			})
			return
		end
		local rootPayload = serializeUiNode(resolved.root)
		local okPush, pushResp = pushUiSnapshot("partial", { rootPayload })
		if not okPush or pushResp.ok ~= true then
			sendResult(command.commandId, false, nil, {
				code = "push_failed",
				message = tostring(pushResp),
			})
			return
		end
		sendResult(command.commandId, true, {
			path = rootPayload.path,
			version = rootPayload.version,
		}, nil)
		addLog("info", "snapshot", "snapshot_ui_subtree ok", table.concat(rootPayload.path, "/"))
		setSyncNow()
		return
	end

	if commandType == "mutate_ui_batch_if_version" then
		if state.playState ~= "stopped" and state.playState ~= "error" then
			sendResult(command.commandId, false, nil, {
				code = "play_mutation_forbidden",
				message = "UI mutations are forbidden during playtest",
				details = { playState = state.playState },
			})
			return
		end
		local operations = payload.operations
		local targetPath = payload.rootPath
		if type(targetPath) ~= "table" or #targetPath == 0 then
			targetPath = nil
			if type(operations) == "table" and #operations > 0 then
				targetPath = uiMutationTargetPath(operations[1])
			end
		end
		local resolvedTarget, targetErrCode, targetErrDetails = resolveUiPath(targetPath)
		if not resolvedTarget then
			sendResult(command.commandId, false, nil, {
				code = targetErrCode or "not_found",
				message = (targetErrCode == "path_blocked_by_non_ui_child") and "UI mutation target is blocked by a non-UI child" or "UI mutation target not found",
				details = targetErrDetails,
			})
			return
		end
		local currentVersion = serializeUiNode(resolvedTarget.instance).version
		if tostring(payload.expectedVersion or "") ~= currentVersion then
			sendResult(command.commandId, false, nil, {
				code = "version_conflict",
				message = "UI version mismatch in Studio",
				details = {
					expectedVersion = tostring(payload.expectedVersion or ""),
					currentVersion = currentVersion,
				},
			})
			return
		end
		for index, operation in ipairs(operations) do
			local okOp, opCode, opMessage, opDetails = executeUiOperation(operation)
			if not okOp then
				local errorDetails = {
					operationIndex = index,
					operation = operation,
				}
				if type(opDetails) == "table" then
					for key, value in pairs(opDetails) do
						errorDetails[key] = value
					end
				end
				sendResult(command.commandId, false, nil, {
					code = opCode or "batch_operation_failed",
					message = tostring(opMessage or "UI mutation failed"),
					details = errorDetails,
				})
				return
			end
		end
		sendResult(command.commandId, true, {
			ok = true,
		}, nil)
		addLog("info", "write", "ui mutation ok", tostring(targetPath and table.concat(targetPath, "/") or ""))
		setSyncNow()
		return
	end

	if commandType == "set_script_source_if_hash" then
		local path = payload.path
		local expectedHash = tostring(payload.expectedHash or "")
		local newSource, decodeCode, decodeMessage = decodeIncomingSource(payload)
		if not newSource then
			sendResult(command.commandId, false, nil, {
				code = decodeCode or "invalid_base64",
				message = tostring(decodeMessage or "Failed to decode source payload"),
			})
			return
		end
		local scriptInstance = findByPath(path)
		if not scriptInstance then
			addLog("warn", "write", "update not_found", tostring(path and table.concat(path, "/") or ""))
			sendResult(command.commandId, false, nil, {
				code = "not_found",
				message = "Script not found for path",
				details = {
					path = path,
				},
			})
			return
		end

		local currentSource, readCode, readMessage = DraftAccess.readSource(scriptInstance)
		if not currentSource then
			addLog("error", "write", "update read failed", tostring(readMessage or readCode))
			sendResult(command.commandId, false, nil, {
				code = readCode or "draft_unavailable",
				message = tostring(readMessage or "Failed to read script via draft pipeline"),
				details = {
					path = path,
				},
			})
			return
		end
		local currentHash = sourceHash(currentSource)
		if currentHash ~= expectedHash then
			addLog("warn", "write", "hash conflict", string.format("expected=%s current=%s", expectedHash, currentHash))
			sendResult(command.commandId, false, nil, {
				code = "hash_conflict",
				message = "Hash mismatch in Studio",
				details = {
					expectedHash = expectedHash,
					currentHash = currentHash,
				},
			})
			return
		end

		local okSet, setCode, setErr, writeChannel, warningCode, warningMessage = DraftAccess.writeSource(scriptInstance, newSource)
		if not okSet then
			addLog("error", "write", "update write failed", tostring(setErr or setCode))
			sendResult(command.commandId, false, nil, {
				code = setCode or "draft_write_failed",
				message = tostring(setErr or "Draft write failed"),
			})
			return
		end
		if warningCode and warningMessage then
			setWarning(tostring(warningCode) .. ": " .. tostring(warningMessage))
		end

		local scriptPayload, afterCode, afterMessage = serializeScript(scriptInstance)
		if not scriptPayload then
			addLog("error", "write", "post-write read failed", tostring(afterMessage or afterCode))
			sendResult(command.commandId, false, nil, {
				code = afterCode or "draft_unavailable",
				message = tostring(afterMessage or "Failed to read updated script"),
			})
			return
		end
		local okPush, pushResp = pushSnapshot("partial", { scriptPayload })
		if not okPush or pushResp.ok ~= true then
			addLog("error", "write", "post-write push failed", tostring(pushResp))
			sendResult(command.commandId, false, nil, {
				code = "push_failed",
				message = tostring(pushResp),
			})
			return
		end

		sendResult(command.commandId, true, {
			path = scriptPayload.path,
			hash = scriptPayload.hash,
			writeChannel = writeChannel,
			draftAware = true,
			warningCode = warningCode,
			warningMessage = warningMessage,
		}, nil)
		addLog("info", "write", "update ok", table.concat(scriptPayload.path, "/"))
		setSyncNow()
		return
	end

	if commandType == "delete_script_if_hash" then
		local path = payload.path
		local expectedHash = tostring(payload.expectedHash or "")
		local scriptInstance = findByPath(path)
		if not scriptInstance then
			sendResult(command.commandId, false, nil, {
				code = "not_found",
				message = "Script not found for path",
				details = {
					path = path,
				},
			})
			return
		end
		local currentSource, readCode, readMessage = DraftAccess.readSource(scriptInstance)
		if not currentSource then
			sendResult(command.commandId, false, nil, {
				code = readCode or "draft_unavailable",
				message = tostring(readMessage or "Failed to read script via draft pipeline"),
				details = {
					path = path,
				},
			})
			return
		end
		local currentHash = sourceHash(currentSource)
		if currentHash ~= expectedHash then
			sendResult(command.commandId, false, nil, {
				code = "hash_conflict",
				message = "Hash mismatch in Studio",
				details = {
					expectedHash = expectedHash,
					currentHash = currentHash,
				},
			})
			return
		end
		scriptInstance:Destroy()
		sendResult(command.commandId, true, {
			path = path,
			deleted = true,
		}, nil)
		addLog("info", "write", "delete ok", table.concat(path, "/"))
		setSyncNow()
		return
	end

	if commandType == "move_script_if_hash" then
		local path = payload.path
		local expectedHash = tostring(payload.expectedHash or "")
		local newParentPath = payload.newParentPath
		local newName = tostring(payload.newName or "")
		local scriptInstance = findByPath(path)
		if not scriptInstance then
			sendResult(command.commandId, false, nil, {
				code = "not_found",
				message = "Script not found for path",
				details = {
					path = path,
				},
			})
			return
		end
		local currentSource, readCode, readMessage = DraftAccess.readSource(scriptInstance)
		if not currentSource then
			sendResult(command.commandId, false, nil, {
				code = readCode or "draft_unavailable",
				message = tostring(readMessage or "Failed to read script via draft pipeline"),
				details = {
					path = path,
				},
			})
			return
		end
		local currentHash = sourceHash(currentSource)
		if currentHash ~= expectedHash then
			sendResult(command.commandId, false, nil, {
				code = "hash_conflict",
				message = "Hash mismatch in Studio",
				details = {
					expectedHash = expectedHash,
					currentHash = currentHash,
				},
			})
			return
		end
		local newParent = findInstanceByPath(newParentPath)
		if not newParent then
			sendResult(command.commandId, false, nil, {
				code = "script_parent_not_found",
				message = "Target script parent not found",
				details = {
					newParentPath = newParentPath,
				},
			})
			return
		end
		local finalName = (newName ~= "" and newName) or scriptInstance.Name
		local existing = newParent:FindFirstChild(finalName)
		if existing and existing ~= scriptInstance then
			if isLuaScript(existing) then
				sendResult(command.commandId, false, nil, {
					code = "already_exists",
					message = "A script already exists at the target path",
					details = {
						path = makePathCopy(newParentPath),
						newName = finalName,
					},
				})
			else
				sendResult(command.commandId, false, nil, {
					code = "path_occupied_by_non_script_child",
					message = "Target name is occupied by a non-script instance",
					details = {
						path = makePathCopy(newParentPath),
						newName = finalName,
						blockedClassName = existing.ClassName,
					},
				})
			end
			return
		end
		scriptInstance.Name = finalName
		scriptInstance.Parent = newParent
		local scriptPayload, afterCode, afterMessage = serializeScript(scriptInstance)
		if not scriptPayload then
			sendResult(command.commandId, false, nil, {
				code = afterCode or "draft_unavailable",
				message = tostring(afterMessage or "Failed to read moved script"),
			})
			return
		end
		local okPush, pushResp = pushSnapshot("partial", { scriptPayload })
		if not okPush or pushResp.ok ~= true then
			sendResult(command.commandId, false, nil, {
				code = "push_failed",
				message = tostring(pushResp),
			})
			return
		end
		sendResult(command.commandId, true, {
			path = scriptPayload.path,
			hash = scriptPayload.hash,
			className = scriptPayload.class,
			draftAware = true,
			readChannel = scriptPayload.readChannel,
		}, nil)
		addLog("info", "write", "move ok", table.concat(scriptPayload.path, "/"))
		setSyncNow()
		return
	end

	if commandType == "upsert_script" then
		local path = payload.path
		local className = tostring(payload.className or "LocalScript")
		local newSource, decodeCode, decodeMessage = decodeIncomingSource(payload)
		if not newSource then
			sendResult(command.commandId, false, nil, {
				code = decodeCode or "invalid_base64",
				message = tostring(decodeMessage or "Failed to decode source payload"),
			})
			return
		end
		local scriptInstance, err = getOrCreateScriptByPath(path, className)
		if not scriptInstance then
			addLog("error", "write", "upsert path failed", tostring(err))
			sendResult(command.commandId, false, nil, {
				code = "upsert_failed",
				message = tostring(err),
				details = {
					path = path,
					className = className,
				},
			})
			return
		end

		local okSet, setCode, setErr, writeChannel, warningCode, warningMessage = DraftAccess.writeSource(scriptInstance, newSource)
		if not okSet then
			addLog("error", "write", "upsert write failed", tostring(setErr or setCode))
			sendResult(command.commandId, false, nil, {
				code = setCode or "draft_write_failed",
				message = tostring(setErr or "Draft write failed"),
			})
			return
		end
		if warningCode and warningMessage then
			setWarning(tostring(warningCode) .. ": " .. tostring(warningMessage))
		end

		local scriptPayload, afterCode, afterMessage = serializeScript(scriptInstance)
		if not scriptPayload then
			addLog("error", "write", "upsert read failed", tostring(afterMessage or afterCode))
			sendResult(command.commandId, false, nil, {
				code = afterCode or "draft_unavailable",
				message = tostring(afterMessage or "Failed to read updated script"),
			})
			return
		end
		local okPush, pushResp = pushSnapshot("partial", { scriptPayload })
		if not okPush or pushResp.ok ~= true then
			addLog("error", "write", "upsert push failed", tostring(pushResp))
			sendResult(command.commandId, false, nil, {
				code = "push_failed",
				message = tostring(pushResp),
			})
			return
		end

		sendResult(command.commandId, true, {
			path = scriptPayload.path,
			hash = scriptPayload.hash,
			className = scriptPayload.class,
			writeChannel = writeChannel,
			draftAware = true,
			warningCode = warningCode,
			warningMessage = warningMessage,
		}, nil)
		addLog("info", "write", "upsert ok", table.concat(scriptPayload.path, "/"))
		setSyncNow()
		return
	end

	if commandType == "snapshot_ui_layout_by_path" then
		local resolved, errCode, errDetails = resolveUiPath(payload.path)
		if not resolved then
			sendResult(command.commandId, false, nil, {
				code = errCode or "not_found",
				message = "UI layout target not found",
				details = errDetails or { path = payload.path },
			})
			return
		end
		local rootClassName = resolved.root and resolved.root.ClassName or resolved.instance.ClassName
		local partialGeometryOnly = rootClassName == "SurfaceGui" or rootClassName == "BillboardGui"
		sendResult(command.commandId, true, {
			root = serializeUiLayoutNode(resolved.instance),
			rootClassName = rootClassName,
			screenSpace = not partialGeometryOnly,
			partialGeometryOnly = partialGeometryOnly,
		}, nil)
		addLog("info", "snapshot", "snapshot_ui_layout ok", table.concat(resolved.path, "/"))
		return
	end

	addLog("warn", "poll", "unsupported command", tostring(commandType))
	sendResult(command.commandId, false, nil, {
		code = "unsupported_command",
		message = "Unsupported command type: " .. tostring(commandType),
	})
end

local function hello()
	if isPlayDataModel() then
		return false, "Bridge networking is disabled in play DataModel"
	end
	applyConnectionState("connecting")
	addLog("info", "connection", "hello", "sending /hello")
	local ok, resp = requestJson("/hello", {
		clientId = state.clientId,
		placeId = tostring(game.PlaceId),
		placeName = game.Name,
		pluginVersion = PLUGIN_VERSION,
		editorApiAvailable = DraftAccess.editorApiAvailable() and true or false,
		base64Transport = true,
		logCaptureAvailable = state.logCaptureAvailable and true or false,
	})
	if not ok then
		addLog("error", "connection", "hello failed", tostring(resp))
		return false, resp
	end
	if type(resp) ~= "table" or resp.ok ~= true or type(resp.sessionId) ~= "string" then
		addLog("error", "connection", "hello invalid response", tostring(resp))
		return false, "Invalid /hello response"
	end
	state.sessionId = resp.sessionId
	state.connectionState = "online"
	addLog("info", "connection", "hello ok", state.sessionId)
	updateUi()
	return true, nil
end

local function reconnectNow()
	if isPlayDataModel() then
		setWarning("Reconnect is unavailable from the play DataModel; use the edit session plugin.")
		return false
	end
	addLog("info", "connection", "reconnect", "manual reconnect")
	state.sessionId = nil
	local okPing, pingErr = pingBridge()
	if not okPing then
		setError(pingErr)
		return false
	end
	local okHello, helloErr = hello()
	if not okHello then
		setError("Connect fail: " .. tostring(helloErr))
		return false
	end
	state.lastError = nil
	state.lastErrorAt = nil
	state.connectionState = "online"
	updateUi()
	return true
end

local function pollOnce()
	if isPlayDataModel() then
		return
	end
	if not state.sessionId then
		local okHello, helloErr = hello()
		if not okHello then
			error("Connect fail: " .. tostring(helloErr))
		end
	end

	local okPoll, pollResp = requestJson("/poll", {
		sessionId = state.sessionId,
		waitMs = POLL_WAIT_MS,
	})
	if not okPoll then
		state.sessionId = nil
		state.connectionState = "error"
		error(pollResp)
	end
	if type(pollResp) ~= "table" or pollResp.ok ~= true then
		state.sessionId = nil
		state.connectionState = "error"
		error("Invalid /poll response")
	end
	state.connectionState = "online"

	local commands = pollResp.commands or {}
	if type(commands) ~= "table" then
		flushRuntimeLogs()
		return
	end
	if #commands > 0 then
		addLog("info", "poll", "commands received", string.format("count=%d", #commands))
	end

	for _, command in ipairs(commands) do
		local okExec, execErr = xpcall(function()
			execCommand(command)
		end, debug.traceback)
		if not okExec then
			sendInternalCommandError(command, execErr)
		end
	end
	flushRuntimeLogs()
end

local function ensureLoop()
	if state.loopStarted then
		return
	end
	state.loopStarted = true
	task.spawn(function()
		while true do
			if state.playState == "starting" and RunService:IsRunning() then
				state.playState = (state.playMode == "run") and "running" or "playing"
				safeUpdateUi()
			elseif (state.playState == "playing" or state.playState == "running" or state.playState == "stopping") and not RunService:IsRunning() then
				state.playState = "stopped"
				state.playMode = nil
				state.playSessionId = nil
				safeUpdateUi()
			end
			if not state.enabled then
				task.wait(0.6)
			elseif isPlayDataModel() then
				if not state.playBridgeSuppressedNoticeShown then
					state.playBridgeSuppressedNoticeShown = true
					emitOutput("warn", "Bridge networking suppressed in play DataModel; edit session remains authoritative")
					addLog("warn", "connection", "play bridge suppressed", "Play DataModel plugin instance will not call /hello or /poll")
				end
				task.wait(1.0)
			elseif not HttpService.HttpEnabled then
				if not state.httpDisabledNoticeShown then
					state.httpDisabledNoticeShown = true
					setError("Enable HTTP requests in Studio settings")
				end
				task.wait(1.2)
			else
				state.httpDisabledNoticeShown = false
				state.playBridgeSuppressedNoticeShown = false
				local ok, err = pcall(pollOnce)
				if not ok then
					local errText = tostring(err)
					setError(errText)
					if isRequestLimitMessage(errText) or string.find(errText, "Request backoff active", 1, true) ~= nil then
						task.wait(math.max(2.5, (state.requestBackoffUntil or 0) - os.clock()))
					else
						task.wait(1.5)
					end
				elseif (state.requestBackoffUntil or 0) > os.clock() then
					task.wait(math.max(0.5, (state.requestBackoffUntil or 0) - os.clock()))
				end
			end
		end
	end)
end

local function applyConnectionInputs(clearError)
	local parsedPort, portErr = normalizePort(urlInput.Text)
	if not parsedPort then
		portErrorLabel.Visible = true
		portErrorLabel.Text = tostring(portErr)
		addLog("warn", "ui", "Port validation failed", tostring(portErr))
		return false
	end
	portErrorLabel.Visible = false
	portErrorLabel.Text = ""

	state.bridgePort = parsedPort
	state.bridgeHost = normalizeHost(hostInput.Text)
	state.bridgeScheme = normalizeScheme(schemeInput.Text)
	state.bridgeBaseUrl = buildBridgeBaseUrl(state.bridgeScheme, state.bridgeHost, state.bridgePort)
	persistBridgeSettings()
	state.sessionId = nil
	if clearError then
		state.lastError = nil
		state.lastErrorAt = nil
	end
	addLog("info", "ui", "Connection settings applied", state.bridgeBaseUrl)
	updateUi()
	return true
end

toggleButton.MouseButton1Click:Connect(function()
	state.enabled = not state.enabled
	if not state.enabled then
		state.sessionId = nil
		state.connectionState = "idle"
	end
	addLog("info", "ui", "Bridge toggled", state.enabled and "enabled" or "disabled")
	updateUi()
end)

urlInput.FocusLost:Connect(function(enterPressed)
	if not enterPressed then
		urlInput.Text = state.bridgePort
		return
	end
	applyConnectionInputs(true)
end)

hostInput.FocusLost:Connect(function(enterPressed)
	if not enterPressed then
		hostInput.Text = state.bridgeHost
		return
	end
	applyConnectionInputs(false)
end)

schemeInput.FocusLost:Connect(function(enterPressed)
	if not enterPressed then
		schemeInput.Text = state.bridgeScheme
		return
	end
	applyConnectionInputs(false)
end)

diagnosticsToggle.MouseButton1Click:Connect(function()
	state.uiDiagExpanded = not state.uiDiagExpanded
	plugin:SetSetting("rbxmcp_ui_diag_expanded", state.uiDiagExpanded)
	updateUi()
end)

clearDiagnosticsButton.MouseButton1Click:Connect(function()
	state.lastError = nil
	state.lastErrorAt = nil
	state.lastWarning = nil
	state.lastWarningAt = nil
	addLog("info", "ui", "Diagnostics cleared", "")
	updateUi()
end)

logToggleButton.MouseButton1Click:Connect(function()
	state.uiLogExpanded = not state.uiLogExpanded
	plugin:SetSetting("rbxmcp_ui_log_expanded", state.uiLogExpanded)
	updateUi()
end)

clearLogButton.MouseButton1Click:Connect(function()
	state.logEntries = {}
	state.logDropped = 0
	state.logExpandedMap = {}
	renderLogEntries()
end)

reconnectButton.MouseButton1Click:Connect(function()
	if applyConnectionInputs(true) then
		reconnectNow()
	end
end)

pingButton.MouseButton1Click:Connect(function()
	if not applyConnectionInputs(false) then
		return
	end
	local okPing, pingErr = pingBridge()
	if okPing then
		state.lastError = nil
		state.lastErrorAt = nil
		state.connectionState = "online"
		state.lastSync = nowIso()
		updateUi()
	else
		setError(pingErr)
	end
end)

openButton.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

quickStartButton.MouseButton1Click:Connect(function()
	setActivePage(state.activePage == "helper" and "main" or "helper")
end)

promptRuButton.MouseButton1Click:Connect(function()
	state.helperLanguage = "RU"
	updateHelperUi()
end)

promptEnButton.MouseButton1Click:Connect(function()
	state.helperLanguage = "EN"
	updateHelperUi()
end)

widget:GetPropertyChangedSignal("AbsoluteSize"):Connect(function()
	updateResponsiveLayout()
end)

addLog("info", "ui", "Plugin initialized", state.bridgeBaseUrl)
updateUi()
ensureLoop()









