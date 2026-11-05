import { defineLocaleTables } from "@regenic/connector-contract";

export const copilotLocaleTables = defineLocaleTables({
  en: {
    "catalog.title": "GitHub Copilot",
    "catalog.channelLabel": "GitHub Copilot",
    "catalog.description":
      "Run Copilot tasks in one local folder. Existing CLI, VS Code, and desktop chats are not imported. Sessions created here show up in the inbox after a sync.",
    "catalog.credentialHint":
      "Uses the Copilot account already signed in on this Mac. No token is stored here.",
    "catalog.syncUnavailable":
      "Open settings and choose to run tasks in this folder. Saving adds it to Rules.",
    "field.workspace": "Folder",
    "field.workspace.placeholder": "The project Copilot may work in",
    "field.tasks": "Tasks",
    "field.tasks.off": "Don't run tasks yet",
    "field.tasks.on": "Run tasks in this folder",
    "confirm.warning":
      "Copilot can run commands in this folder. The folder is not a sandbox, and a command may reach files outside it. Each permission request stays denied until you approve it.",
    "confirm.ack": "Run Copilot tasks in this folder.",
    "present.pending": "GitHub Copilot",
  },
  zh: {
    "catalog.title": "GitHub Copilot",
    "catalog.channelLabel": "GitHub Copilot",
    "catalog.description":
      "在一个本地文件夹里执行 Copilot 任务。不会导入 CLI、VS Code 或桌面版里已有的会话。这里创建的会话同步后会出现在收件箱。",
    "catalog.credentialHint": "使用这台 Mac 上已经登录的 Copilot 账号，这里不保存 token。",
    "catalog.syncUnavailable":
      "点「编辑范围」，选择「在这个文件夹里执行任务」并保存。保存后到「规则」里选用它。",
    "field.workspace": "文件夹",
    "field.workspace.placeholder": "Copilot 可以在这里工作的项目",
    "field.tasks": "任务",
    "field.tasks.off": "先不执行任务",
    "field.tasks.on": "在这个文件夹里执行任务",
    "confirm.warning":
      "Copilot 可以在这个文件夹里运行命令。文件夹不是沙箱，命令仍可能访问外面的文件。权限请求在你批准之前都会拒绝。",
    "confirm.ack": "允许在这个文件夹里执行 Copilot 任务。",
    "present.pending": "GitHub Copilot",
  },
});
