import { describe, expect, it } from "vitest";
import * as icons from "../../src/lib/fileIconData";
import { installFileIcons, resolveIconPath } from "../../src/lib/fileIcons";

installFileIcons(icons);

describe("resolveIconPath docker 文件名", () => {
  const docker = resolveIconPath("docker-compose.yml", false);

  it("以 docker 开头的文件用 Docker 图标", () => {
    expect(docker).toBe("material/docker.svg");
    expect(resolveIconPath("docker-compose.rustfs.yml", false)).toBe(docker);
    expect(resolveIconPath("docker-compose.override.yaml", false)).toBe(docker);
    expect(resolveIconPath("Dockerfile", false)).toBe(docker);
  });

  it("普通 yml 和目录名不受这条前缀影响", () => {
    expect(resolveIconPath("application.yml", false)).not.toBe(docker);
    expect(resolveIconPath("docker", true)).not.toBe(docker);
  });
});

describe("resolveIconPath 忽略规则文件", () => {
  it("*ignore 文件统一走 ignored 图标，盖过 material 的工具 logo", () => {
    expect(resolveIconPath(".dockerignore", false)).toBe("expui/fileTypes/ignored.svg");
    expect(resolveIconPath(".npmignore", false)).toBe("expui/fileTypes/ignored.svg");
    expect(resolveIconPath(".eslintignore", false)).toBe("expui/fileTypes/ignored.svg");
    expect(resolveIconPath(".rgignore", false)).toBe("expui/fileTypes/ignored.svg");
  });

  it(".gitignore 有专属 gitignore 图标，不吃 ignored 兜底", () => {
    expect(resolveIconPath(".gitignore", false)).not.toBe("expui/fileTypes/ignored.svg");
  });
});
