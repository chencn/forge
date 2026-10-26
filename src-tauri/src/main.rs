// 在 Windows 下始终以 GUI 子系统运行，禁止弹出控制台黑窗（无论是 Debug 还是 Release 模式）。
#![windows_subsystem = "windows"]

fn main() {
    forge_lib::run()
}
