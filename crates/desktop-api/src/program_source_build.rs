use std::fs;
use std::path::{Path as FsPath, PathBuf};
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

const PROGRAM_SOURCE_BUILD_TIMEOUT_SECS: u64 = 30 * 60;
const PROGRAM_SOURCE_BUILD_LOG_BYTES: usize = 24 * 1024;

#[derive(Debug)]
pub(crate) struct ProgramSourceBuildError {
    pub(crate) message: String,
}

impl ProgramSourceBuildError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct ProgramSourceBuildPlan {
    pub(crate) command: Vec<String>,
    pub(crate) display_command: String,
    pub(crate) template: String,
}

impl ProgramSourceBuildPlan {
    fn new(template: &str, command: &[&str]) -> Self {
        Self {
            command: command.iter().map(|part| (*part).to_string()).collect(),
            display_command: command.join(" "),
            template: template.to_string(),
        }
    }

    pub(crate) fn display_command_with_clean(&self) -> String {
        format!("cargo clean && {}", self.display_command)
    }
}

pub(crate) struct ProgramSourceBuildOutcome {
    pub(crate) command: String,
    pub(crate) template: String,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) warnings: Vec<String>,
}

struct ProgramSourceBuildPreparation {
    stdout: String,
    stderr: String,
    cleaned: bool,
}

struct PreservedProgramSourceFile {
    relative_path: PathBuf,
    bytes: Vec<u8>,
}

pub(crate) fn display_program_source_build_command(
    root: &FsPath,
    plan: &ProgramSourceBuildPlan,
) -> String {
    if root.join("Cargo.toml").is_file() {
        plan.display_command_with_clean()
    } else {
        plan.display_command.clone()
    }
}

pub(crate) fn program_source_build_plans(
    root: &FsPath,
) -> (Vec<ProgramSourceBuildPlan>, Option<String>) {
    let mut plans = Vec::new();
    if root.join("Anchor.toml").is_file() {
        plans.push(ProgramSourceBuildPlan::new(
            "fnzero-safe 内置 Anchor 模板",
            &["anchor", "build"],
        ));
    }
    if root.join("Cargo.toml").is_file() {
        plans.push(ProgramSourceBuildPlan::new(
            "fnzero-safe 内置 Cargo SBF 模板",
            &["cargo", "build-sbf"],
        ));
    }
    if plans.is_empty() {
        (
            plans,
            Some("未识别 Anchor.toml 或 Cargo.toml，无法使用标准工具链编译".to_string()),
        )
    } else {
        (plans, None)
    }
}

pub(crate) fn program_source_keys_build_warning(root: &FsPath) -> Option<String> {
    root.join(".keys").exists().then(|| {
        "源码目录包含 .keys；FnzSafe 不会执行项目脚本或 Makefile，仅使用标准 Anchor/Cargo 工具链编译".to_string()
    })
}

pub(crate) async fn execute_program_source_build(
    source_dir: &FsPath,
    build_plans: &[ProgramSourceBuildPlan],
    build_blocked_reason: Option<String>,
    artifact_stem: Option<&str>,
    find_program_so_path: impl Fn(&FsPath, Option<&str>) -> Option<PathBuf>,
    find_program_idl_path: impl Fn(&FsPath, Option<&str>) -> Option<PathBuf>,
) -> Result<ProgramSourceBuildOutcome, ProgramSourceBuildError> {
    if build_plans.is_empty() {
        return Err(ProgramSourceBuildError::new(
            build_blocked_reason.unwrap_or_else(|| "当前源码目录不可自动编译".to_string()),
        ));
    }

    let mut warnings = Vec::new();
    let mut plan_failure_warnings = Vec::new();
    let mut last_error = None;
    let preparation = prepare_program_source_build(source_dir).await?;
    if preparation.cleaned {
        warnings.push("已在编译前执行 cargo clean，避免复用旧的 SBF 构建缓存".to_string());
    }
    for plan in build_plans.iter() {
        match run_program_source_build(source_dir, plan).await {
            Ok((mut build_stdout, mut build_stderr)) => {
                if find_program_so_path(source_dir, artifact_stem).is_none() {
                    let message = format!(
                        "{}: 构建命令已结束，但未生成 target/verifiable/*.so 或 target/deploy/*.so",
                        plan.display_command
                    );
                    plan_failure_warnings.push(message.clone());
                    last_error = Some(message);
                    continue;
                }
                let mut completed_commands = vec![plan.display_command.clone()];
                let mut completed_template = plan.template.clone();
                if source_dir.join("Anchor.toml").is_file()
                    && find_program_idl_path(source_dir, artifact_stem).is_none()
                {
                    let Some(idl_plan) = anchor_idl_build_plan(artifact_stem) else {
                        let message =
                            "Anchor 构建已生成 .so，但无法识别程序名称，不能生成 IDL".to_string();
                        plan_failure_warnings.push(message.clone());
                        last_error = Some(message);
                        continue;
                    };
                    if let Err(error) = prepare_anchor_idl_output_dir(source_dir) {
                        let message = format!("{}: {}", idl_plan.display_command, error.message);
                        plan_failure_warnings.push(message.clone());
                        last_error = Some(message);
                        continue;
                    }
                    match run_program_source_build(source_dir, &idl_plan).await {
                        Ok((idl_stdout, idl_stderr)) => {
                            build_stdout = join_program_source_logs([build_stdout, idl_stdout]);
                            build_stderr = join_program_source_logs([build_stderr, idl_stderr]);
                        }
                        Err(error) => {
                            let message =
                                format!("{}: {}", idl_plan.display_command, error.message);
                            plan_failure_warnings.push(message.clone());
                            last_error = Some(message);
                            continue;
                        }
                    }
                    if find_program_idl_path(source_dir, artifact_stem).is_none() {
                        let message = format!(
                            "{}: 命令已结束，但未生成 target/idl/*.json",
                            idl_plan.display_command
                        );
                        plan_failure_warnings.push(message.clone());
                        last_error = Some(message);
                        continue;
                    }
                    completed_commands.push(idl_plan.display_command);
                    completed_template = format!("{} + Anchor IDL", plan.template);
                }
                if !plan_failure_warnings.is_empty() {
                    warnings.append(&mut plan_failure_warnings);
                    warnings.push(format!("已改用 {} 完成编译", plan.template));
                }
                let build_command = completed_commands.join(" && ");
                let command = if preparation.cleaned {
                    format!("cargo clean && {build_command}")
                } else {
                    build_command
                };
                return Ok(ProgramSourceBuildOutcome {
                    command,
                    template: completed_template,
                    stdout: join_program_source_logs([preparation.stdout.clone(), build_stdout]),
                    stderr: join_program_source_logs([preparation.stderr.clone(), build_stderr]),
                    warnings,
                });
            }
            Err(error) => {
                let message = format!("{}: {}", plan.display_command, error.message);
                plan_failure_warnings.push(message.clone());
                last_error = Some(message);
            }
        }
    }

    Err(ProgramSourceBuildError::new(last_error.unwrap_or_else(
        || build_blocked_reason.unwrap_or_else(|| "构建完成后未找到可部署 .so".to_string()),
    )))
}

fn truncate_build_log(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    if text.len() <= PROGRAM_SOURCE_BUILD_LOG_BYTES {
        return text.to_string();
    }
    let start = text.len().saturating_sub(PROGRAM_SOURCE_BUILD_LOG_BYTES);
    format!("...[truncated]{}", &text[start..])
}

fn join_program_source_logs(parts: impl IntoIterator<Item = String>) -> String {
    parts
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn program_source_command_with_env(
    root: &FsPath,
    command: &[String],
) -> Result<Command, ProgramSourceBuildError> {
    let executable = command
        .first()
        .ok_or_else(|| ProgramSourceBuildError::new("命令为空"))?;
    let mut process = Command::new(executable);
    process.args(command.iter().skip(1)).current_dir(root);
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        let candidate_bins = [
            home.join(".nvm/versions/node/v20.19.5/bin"),
            home.join(".avm/bin"),
            home.join(".cargo/bin"),
            home.join(".local/share/solana/install/active_release/bin"),
        ];
        let current_path = std::env::var_os("PATH").unwrap_or_default();
        let mut paths = std::env::split_paths(&current_path).collect::<Vec<_>>();
        for bin in candidate_bins.into_iter().rev() {
            if bin.is_dir() {
                paths.insert(0, bin);
            }
        }
        if let Ok(path) = std::env::join_paths(paths) {
            process.env("PATH", path);
        }
    }
    Ok(process)
}

async fn run_program_source_command(
    root: &FsPath,
    command: &[String],
    label: &str,
) -> Result<(String, String), ProgramSourceBuildError> {
    let mut process = program_source_command_with_env(root, command)?;
    let output = timeout(
        Duration::from_secs(PROGRAM_SOURCE_BUILD_TIMEOUT_SECS),
        process.output(),
    )
    .await
    .map_err(|_| ProgramSourceBuildError::new(format!("{label} 超时")))?
    .map_err(|error| ProgramSourceBuildError::new(format!("启动 {label} 失败: {error}")))?;
    let stdout = truncate_build_log(&output.stdout);
    let stderr = truncate_build_log(&output.stderr);
    if !output.status.success() {
        return Err(ProgramSourceBuildError::new(format!(
            "{label} 失败: {}\n{}",
            output.status, stderr
        )));
    }
    Ok((stdout, stderr))
}

fn preserve_target_deploy_keypairs(
    root: &FsPath,
) -> Result<Vec<PreservedProgramSourceFile>, ProgramSourceBuildError> {
    let deploy_dir = root.join("target/deploy");
    let Ok(entries) = fs::read_dir(&deploy_dir) else {
        return Ok(Vec::new());
    };
    let mut preserved = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !path.is_file() || !name.ends_with("-keypair.json") {
            continue;
        }
        let Some(stem) = name.strip_suffix("-keypair.json") else {
            continue;
        };
        if safe_artifact_stem(stem).as_deref() != Some(stem) {
            continue;
        }
        let path = canonical_child_path(root, &path, "target/deploy Program keypair")?;
        let bytes = read_bytes_file_limited(
            &path,
            crate::program_deploy::MAX_PROGRAM_KEYPAIR_JSON_BYTES,
            "target/deploy Program keypair",
        )?;
        let relative_path = PathBuf::from("target").join("deploy").join(name);
        preserved.push(PreservedProgramSourceFile {
            relative_path,
            bytes,
        });
    }
    Ok(preserved)
}

fn restore_preserved_program_source_files(
    root: &FsPath,
    files: &[PreservedProgramSourceFile],
) -> Result<(), ProgramSourceBuildError> {
    for file in files {
        let path = root.join(&file.relative_path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                ProgramSourceBuildError::new(format!(
                    "恢复 {} 失败: {error}",
                    file.relative_path.display()
                ))
            })?;
        }
        if path.exists() {
            continue;
        }
        fs::write(&path, &file.bytes).map_err(|error| {
            ProgramSourceBuildError::new(format!(
                "恢复 {} 失败: {error}",
                file.relative_path.display()
            ))
        })?;
    }
    Ok(())
}

async fn clean_program_source_build_cache(
    root: &FsPath,
) -> Result<(String, String, bool), ProgramSourceBuildError> {
    if !root.join("Cargo.toml").is_file() {
        return Ok((
            String::new(),
            "未找到 Cargo.toml，已跳过 cargo clean".to_string(),
            false,
        ));
    }
    let command = vec!["cargo".to_string(), "clean".to_string()];
    let preserved = preserve_target_deploy_keypairs(root)?;
    let result = run_program_source_command(root, &command, "cargo clean").await;
    restore_preserved_program_source_files(root, &preserved)?;
    result.map(|(stdout, stderr)| (stdout, stderr, true))
}

async fn prepare_program_source_build(
    root: &FsPath,
) -> Result<ProgramSourceBuildPreparation, ProgramSourceBuildError> {
    let (clean_stdout, clean_stderr, cleaned) = clean_program_source_build_cache(root).await?;
    Ok(ProgramSourceBuildPreparation {
        stdout: clean_stdout,
        stderr: clean_stderr,
        cleaned,
    })
}

async fn run_program_source_build(
    root: &FsPath,
    plan: &ProgramSourceBuildPlan,
) -> Result<(String, String), ProgramSourceBuildError> {
    let (build_stdout, build_stderr) =
        run_program_source_command(root, &plan.command, &format!("{} 构建", plan.template)).await?;
    Ok((build_stdout, build_stderr))
}

fn anchor_idl_build_plan(artifact_stem: Option<&str>) -> Option<ProgramSourceBuildPlan> {
    let stem = artifact_stem.and_then(safe_artifact_stem)?;
    let output = format!("target/idl/{stem}.json");
    let command = vec![
        "anchor".to_string(),
        "idl".to_string(),
        "build".to_string(),
        "--program-name".to_string(),
        stem,
        "--out".to_string(),
        output,
    ];
    Some(ProgramSourceBuildPlan {
        display_command: command.join(" "),
        command,
        template: "fnzero-safe 内置 Anchor IDL 模板".to_string(),
    })
}

fn prepare_anchor_idl_output_dir(root: &FsPath) -> Result<(), ProgramSourceBuildError> {
    let target_dir = canonical_child_path(root, &root.join("target"), "target")?;
    if !target_dir.is_dir() {
        return Err(ProgramSourceBuildError::new("target 不是目录"));
    }
    let idl_dir = target_dir.join("idl");
    if idl_dir.exists() {
        let idl_dir = canonical_child_path(root, &idl_dir, "target/idl")?;
        if !idl_dir.is_dir() {
            return Err(ProgramSourceBuildError::new("target/idl 不是目录"));
        }
        return Ok(());
    }
    fs::create_dir(&idl_dir)
        .map_err(|error| ProgramSourceBuildError::new(format!("创建 target/idl 失败: {error}")))?;
    let _ = canonical_child_path(root, &idl_dir, "target/idl")?;
    Ok(())
}

fn safe_artifact_stem(value: &str) -> Option<String> {
    let stem = value.trim().replace('-', "_");
    if stem.is_empty()
        || stem.len() > 128
        || !stem
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return None;
    }
    Some(stem)
}

fn canonical_child_path(
    root: &FsPath,
    path: &FsPath,
    label: &str,
) -> Result<PathBuf, ProgramSourceBuildError> {
    let canonical = path
        .canonicalize()
        .map_err(|error| ProgramSourceBuildError::new(format!("读取 {label} 路径失败: {error}")))?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| ProgramSourceBuildError::new(format!("读取源码目录路径失败: {error}")))?;
    if !canonical.starts_with(&canonical_root) {
        return Err(ProgramSourceBuildError::new(format!(
            "{label} 必须位于源码目录内"
        )));
    }
    Ok(canonical)
}

fn read_bytes_file_limited(
    path: &FsPath,
    max_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, ProgramSourceBuildError> {
    let metadata = fs::metadata(path).map_err(|error| {
        ProgramSourceBuildError::new(format!("读取 {label} 元数据失败: {error}"))
    })?;
    if !metadata.is_file() {
        return Err(ProgramSourceBuildError::new(format!(
            "{label} 不是普通文件"
        )));
    }
    if metadata.len() == 0 || metadata.len() > max_bytes as u64 {
        return Err(ProgramSourceBuildError::new(format!("{label} 大小无效")));
    }
    fs::read(path)
        .map_err(|error| ProgramSourceBuildError::new(format!("读取 {label} 失败: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_path(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!(
            "fnzero-safe-{label}-{}-{nanos}",
            std::process::id()
        ))
    }

    #[test]
    fn build_command_displays_clean_for_cargo_sources() {
        let source = unique_temp_path("source-build-command-clean");
        fs::create_dir_all(&source).unwrap();
        let plan =
            ProgramSourceBuildPlan::new("fnzero-safe 内置 Anchor 模板", &["anchor", "build"]);

        assert_eq!(
            display_program_source_build_command(&source, &plan),
            "anchor build"
        );

        fs::write(source.join("Cargo.toml"), "[workspace]\n").unwrap();
        assert_eq!(
            display_program_source_build_command(&source, &plan),
            "cargo clean && anchor build"
        );

        let _ = fs::remove_dir_all(source);
    }

    #[test]
    fn standard_build_plans_ignore_project_owned_commands() {
        let source = unique_temp_path("standard-build-plans-only");
        fs::create_dir_all(source.join("scripts")).unwrap();
        fs::write(source.join("Anchor.toml"), "[workspace]\n").unwrap();
        fs::write(source.join("Cargo.toml"), "[workspace]\n").unwrap();
        fs::write(source.join("Makefile"), "build:\n\t@true\n").unwrap();
        fs::write(source.join("scripts/build-verifiable.sh"), "#!/bin/sh\n").unwrap();

        let (plans, blocked_reason) = program_source_build_plans(&source);

        assert!(blocked_reason.is_none());
        assert_eq!(
            plans
                .iter()
                .map(|plan| plan.display_command.as_str())
                .collect::<Vec<_>>(),
            vec!["anchor build", "cargo build-sbf",]
        );

        let _ = fs::remove_dir_all(source);
    }

    #[test]
    fn anchor_idl_plan_targets_the_selected_program() {
        let plan = anchor_idl_build_plan(Some("my-program")).unwrap();

        assert_eq!(
            plan.command,
            vec![
                "anchor",
                "idl",
                "build",
                "--program-name",
                "my_program",
                "--out",
                "target/idl/my_program.json",
            ]
        );
        assert!(anchor_idl_build_plan(Some("../outside")).is_none());
        assert!(anchor_idl_build_plan(None).is_none());
    }

    #[test]
    fn clean_preserves_target_deploy_keypairs() {
        let source = unique_temp_path("source-clean-preserve-keypairs");
        fs::create_dir_all(source.join("target/deploy")).unwrap();
        fs::write(source.join("Cargo.toml"), "[workspace]\n").unwrap();
        fs::write(source.join("target/deploy/fnzero.so"), b"old-program").unwrap();
        fs::write(source.join("target/deploy/fnzero-keypair.json"), b"[1,2,3]").unwrap();
        fs::write(
            source.join("target/deploy/fnzero.bad-keypair.json"),
            b"[4,5,6]",
        )
        .unwrap();

        let canonical_source = source.canonicalize().unwrap();
        let preserved = preserve_target_deploy_keypairs(&canonical_source).unwrap();
        fs::remove_dir_all(canonical_source.join("target")).unwrap();
        restore_preserved_program_source_files(&canonical_source, &preserved).unwrap();

        assert!(!canonical_source.join("target/deploy/fnzero.so").exists());
        assert!(!canonical_source
            .join("target/deploy/fnzero.bad-keypair.json")
            .exists());
        assert_eq!(
            fs::read(canonical_source.join("target/deploy/fnzero-keypair.json")).unwrap(),
            b"[1,2,3]"
        );

        let _ = fs::remove_dir_all(source);
    }
}
