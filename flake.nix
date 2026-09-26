{
  description = "DeepSeek balance history and spend chip for the dsh shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  # Только ради тестов: хост-половине нужны node_modules ядра dsh (zod,
  # schemastery, dsh-home-paths), а не рантайм харнесса. Сам пакет —
  # просто файлы, ему не нужен ни node, ни npm на этапе сборки.
  # Потребитель подключает этот инпут с `follows`, поэтому повторной копии
  # харнесса в замыкании не появляется.
  inputs.deepseek-harness.url = "github:xilec/deepseek-harness.nix";

  outputs =
    { self, nixpkgs, deepseek-harness }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems f;

      # Раскладка ровно как в репозитории: package.json рядом с src/ и client/.
      # dsh ищет манифест вверх по дереву от импортированного модуля, поэтому
      # строка композиции указывает на src/index.js, а браузерная половина
      # находится через exports["./client"] этого же манифеста.
      #
      # node_modules здесь намеренно нет: его подкладывает потребитель
      # (nixos-config/dsh-balance.nix) симлинком на ядро dsh — так же, как для
      # остальных плагинов с bare-импортами платформенных пакетов.
      plugin =
        pkgs:
        pkgs.runCommand "dsh-balance" { } ''
          mkdir -p $out
          cp ${./package.json} $out/package.json
          cp ${./cordis.patch.yml} $out/cordis.patch.yml
          cp -r ${./src} $out/src
          cp -r ${./client} $out/client
          chmod -R u+w $out
        '';
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        rec {
          dsh-balance = plugin pkgs;
          default = dsh-balance;
        }
      );

      # `nix flake check` прогоняет ту же сюиту, что и `npm test`, на исходниках
      # флейка: node_modules ядра подкладывается симлинком, чтобы bare-импорты
      # (zod и platform-пакеты) разрешались так же, как в работающем dsh.
      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          dshPkgs = pkgs.extend deepseek-harness.overlays.default;
        in
        {
          tests = pkgs.runCommand "dsh-balance-tests" {
            nativeBuildInputs = [ pkgs.nodejs ];
          } ''
            cp -r ${self} source
            chmod -R u+w source
            ln -s ${dshPkgs.dsh.dsh-kernel}/lib/deepseek-harness/node_modules source/node_modules
            cd source
            node --test test/*.test.js
            touch $out
          '';
        }
      );
    };
}
