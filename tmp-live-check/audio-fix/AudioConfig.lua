return {
    Remotes = {
        Play = "Audio:Play",
        Get = "Audio:GetSettings",
        Set = "Audio:SetSettings",
        Changed = "Audio:SettingsChanged"
    },
    Roots = {
        Music = "Music",
        SFX = "Sounds"
    },
    Defaults = {
        Music = true,
        SFX = true,
        Volume = 1,
        MusicVolume = 1,
        SFXVolume = 1
    },
    Open = {
        ShopScreen = "Shop.Open",
        TitanPlantsScreen = "TitanPlants.Open",
        SettingsScreen = "UI.SettingsOpen"
    },
    Close = {
        SettingsScreen = "UI.ScreenClose"
    },
    Weapon = {
        Bat = "Weapon.Attack.BatSwing"
    },
    Cues = {
        ["Music.Main"] = {
            Cat = "Music",
            Path = "BgmMain",
            Id = "rbxassetid://83438848079856",
            V = 0.15,
            D = true,
            L = true
        },
        ["UI.Hover"] = {
            Cat = "SFX",
            Path = "UI/Hover",
            V = 0.24,
            D = true,
            I = 0.02
        },
        ["UI.Press"] = {
            Cat = "SFX",
            Path = "UI/Press",
            V = 0.32,
            D = true,
            I = 0.02
        },
        ["UI.Click"] = {
            Cat = "SFX",
            Path = "UI/Click",
            V = 0.45,
            D = true,
            I = 0.03
        },
        ["UI.ScreenOpen"] = {
            Cat = "SFX",
            Path = "UI/ScreenOpen",
            V = 0.55,
            D = true,
            I = 0.04
        },
        ["UI.ScreenClose"] = {
            Cat = "SFX",
            Path = "UI/ScreenClose",
            V = 0.45,
            D = true,
            I = 0.04
        },
        ["UI.SettingsOpen"] = {
            Cat = "SFX",
            Path = "UI/SettingsOpen",
            V = 0.5,
            D = true,
            I = 0.05
        },
        ["UI.Notification"] = {
            Cat = "SFX",
            Path = "UI/Notification",
            V = 0.55,
            D = true,
            I = 0.05
        },
        ["Shop.Open"] = {
            Cat = "SFX",
            Path = "UI/ShopOpen",
            V = 0.52,
            D = true,
            I = 0.05
        },
        ["TitanPlants.Open"] = {
            Cat = "SFX",
            Path = "UI/TitanPlantsOpen",
            V = 0.52,
            D = true,
            I = 0.05
        },
        ["Brainrot.Collect"] = {
            Cat = "SFX",
            Path = "Brainrot/CurrencyCollect",
            Id = "rbxassetid://72637338897706",
            V = 0.9,
            I = 0.07,
            N = 7,
            X = 70
        },
        ["Weapon.Attack.Generic"] = {
            Cat = "SFX",
            Path = "Weapon/PlantShoot",
            Id = "rbxassetid://111484276142326",
            V = 0.55,
            I = 0.03,
            N = 10,
            X = 55
        },
        ["Weapon.Attack.BatSwing"] = {
            Cat = "SFX",
            Path = "Weapon/BatSwing",
            Id = "rbxassetid://115299459574905",
            V = 0.5,
            I = 0.03,
            N = 8,
            X = 30
        },
        ["Rewards.TimeClaim"] = {
            Cat = "SFX",
            Path = "Rewards/TimeClaim",
            V = 0.65,
            D = true,
            I = 0.08
        },
        ["Rewards.RebirthSuccess"] = {
            Cat = "SFX",
            Path = "Rewards/RebirthSuccess",
            V = 0.7,
            D = true,
            I = 0.1
        },
        ["Rewards.RebirthFail"] = {
            Cat = "SFX",
            Path = "Rewards/RebirthFail",
            V = 0.55,
            D = true,
            I = 0.08
        }
    }
}
