#![cfg_attr(not(windows), allow(dead_code))]

#[cfg(not(windows))]
fn main() {
    eprintln!("CAIRN_SANDBOX_ERROR: this helper only supports Windows");
    std::process::exit(125);
}

#[cfg(windows)]
mod windows_main {
    use flatbuffers::{FlatBufferBuilder, WIPOffset};
    use std::ffi::{c_void, CString};
    use std::fs;
    use std::net::{TcpListener, TcpStream};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::ptr;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT,
        HMODULE,
    };
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
    };
    use windows_sys::Win32::Security::{FreeSid, PSID, SECURITY_CAPABILITIES};
    use windows_sys::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::LibraryLoader::{
        GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
        InitializeProcThreadAttributeList, ResumeThread, TerminateProcess,
        UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED,
        EXTENDED_STARTUPINFO_PRESENT, INFINITE, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
        STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW,
    };

    const HELPER_VERSION: &str = "cairn-windows-sandbox/0.1.0";
    const SANDBOX_SPEC_VERSION: &str = "0.1.0";
    const ERROR_EXIT: i32 = 125;
    const CHILD_POLICY_FAILURE: i32 = 124;

    // FlatBuffer vtable offsets from Microsoft's public
    // BaseContainerSpecification.fbs. Keeping this tiny encoder local avoids
    // shipping a large experimental SDK as part of Cairn's security boundary.
    const SBOX_VERSION: u16 = 4;
    const SBOX_APP_CONTAINER: u16 = 6;
    const SBOX_DISALLOW_WIN32K: u16 = 10;
    const SBOX_UI_RESTRICTIONS: u16 = 12;
    const SBOX_LEAST_PRIVILEGE: u16 = 14;
    const SBOX_CAPABILITIES: u16 = 16;
    const SBOX_FS_READ_WRITE: u16 = 18;
    const SBOX_FS_READ_ONLY: u16 = 20;
    const SBOX_NETWORK_POLICY: u16 = 22;
    const SBOX_FS_DENY: u16 = 26;
    const NETWORK_EGRESS: u16 = 6;
    const ENDPOINT_DEFAULT_ACTION: u16 = 4;

    const PSEC_VERSION: u16 = 4;
    const PSEC_CAPABILITIES: u16 = 6;
    const PSEC_DISALLOW_WIN32K: u16 = 8;
    const PSEC_UI_RESTRICTIONS: u16 = 10;
    const PSEC_FS_READ_WRITE: u16 = 12;
    const PSEC_FS_READ_ONLY: u16 = 14;
    const PSEC_FS_DENY: u16 = 16;
    const PSEC_NETWORK_POLICY: u16 = 18;
    const PSEC_SUPPORT_FS_DENY: u64 = 1;
    const PROC_THREAD_ATTRIBUTE_SECURITY_ENVIRONMENT: usize = 35 | 0x0002_0000;

    // JOB_OBJECT_UILIMIT_* flags: prevent clipboard, global handles/atoms,
    // desktop switching, display/system changes, and ExitWindows operations.
    const ALL_UI_RESTRICTIONS: u64 = 0x00ff;

    type CreateProcessInSandbox = unsafe extern "system" fn(
        *const u16,
        *mut u16,
        *const c_void,
        *const c_void,
        i32,
        u32,
        *const c_void,
        *const u16,
        *const STARTUPINFOW,
        *const u16,
        *const u8,
        u32,
        *mut PROCESS_INFORMATION,
    ) -> i32;

    type DeleteAppContainerProfile = unsafe extern "system" fn(*const u16) -> i32;

    type CreateProcessSecurityEnvironment =
        unsafe extern "system" fn(*const c_void, u32, u32, *mut HANDLE) -> i32;
    type QueryProcessSecurityEnvironmentSupport = unsafe extern "system" fn(*mut u64) -> i32;
    type CloseProcessSecurityEnvironment = unsafe extern "system" fn(HANDLE);

    #[repr(transparent)]
    #[derive(Clone, Copy)]
    struct SchemaVersion([u8; 4]);

    impl SchemaVersion {
        fn new(major: u16, minor: u16) -> Self {
            let mut value = [0; 4];
            value[0..2].copy_from_slice(&major.to_le_bytes());
            value[2..4].copy_from_slice(&minor.to_le_bytes());
            Self(value)
        }
    }

    impl flatbuffers::Push for SchemaVersion {
        type Output = SchemaVersion;

        unsafe fn push(&self, dst: &mut [u8], _written_len: usize) {
            dst.copy_from_slice(&self.0);
        }

        fn alignment() -> flatbuffers::PushAlignment {
            flatbuffers::PushAlignment::new(2)
        }
    }

    #[derive(Debug)]
    struct LaunchPolicy {
        workspace: PathBuf,
        cwd: PathBuf,
        temp: PathBuf,
        denied: Vec<PathBuf>,
        read_only: Vec<PathBuf>,
        network_allow: bool,
    }

    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    struct SecurityEnvironmentGuard {
        handle: HANDLE,
        close: CloseProcessSecurityEnvironment,
    }

    enum LaunchGuard {
        Security(SecurityEnvironmentGuard),
        AppContainer(AppContainerCleanup),
    }

    impl Drop for LaunchGuard {
        fn drop(&mut self) {
            match self {
                Self::Security(guard) => {
                    let _ = guard.handle;
                }
                Self::AppContainer(cleanup) => {
                    let _ = &cleanup.sid;
                }
            }
        }
    }

    struct AppContainerCleanup {
        profile_name: String,
        sid: String,
        acl_roots: Vec<(PathBuf, bool)>,
    }

    impl Drop for AppContainerCleanup {
        fn drop(&mut self) {
            for (path, recursive) in &self.acl_roots {
                remove_acl(path, &self.sid, *recursive);
            }
            cleanup_profile(&self.profile_name);
        }
    }

    impl Drop for SecurityEnvironmentGuard {
        fn drop(&mut self) {
            if !self.handle.is_null() {
                unsafe { (self.close)(self.handle) };
                self.handle = ptr::null_mut();
            }
        }
    }

    struct AttributeList {
        _storage: Vec<usize>,
        list: LPPROC_THREAD_ATTRIBUTE_LIST,
        _environment: Box<HANDLE>,
        _inherited: Box<[HANDLE]>,
        startup_info: STARTUPINFOEXW,
    }

    struct SidGuard(PSID);

    impl Drop for SidGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { FreeSid(self.0) };
                self.0 = ptr::null_mut();
            }
        }
    }

    struct AppContainerAttributeList {
        _storage: Vec<usize>,
        list: LPPROC_THREAD_ATTRIBUTE_LIST,
        _capabilities: Box<SECURITY_CAPABILITIES>,
        _inherited: Box<[HANDLE]>,
        startup_info: STARTUPINFOEXW,
    }

    impl Drop for AppContainerAttributeList {
        fn drop(&mut self) {
            if !self.list.is_null() {
                unsafe { DeleteProcThreadAttributeList(self.list) };
                self.list = ptr::null_mut();
            }
        }
    }

    impl Drop for AttributeList {
        fn drop(&mut self) {
            if !self.list.is_null() {
                unsafe { DeleteProcThreadAttributeList(self.list) };
                self.list = ptr::null_mut();
            }
        }
    }

    pub fn main() {
        let code = match run() {
            Ok(code) => code,
            Err(error) => {
                eprintln!("CAIRN_SANDBOX_ERROR: {error}");
                ERROR_EXIT
            }
        };
        std::process::exit(code);
    }

    fn run() -> Result<i32, String> {
        let args: Vec<String> = std::env::args().skip(1).collect();
        match args.first().map(String::as_str) {
            Some("--version") => {
                println!("{HELPER_VERSION}");
                Ok(0)
            }
            Some("--self-test") => self_test(),
            Some("--self-test-child") => self_test_child(&args[1..]),
            Some("--escape-child") => escape_child(&args[1..]),
            _ => {
                let (policy, command) = parse_launch_args(&args)?;
                launch(&policy, &command)
            }
        }
    }

    fn parse_launch_args(args: &[String]) -> Result<(LaunchPolicy, Vec<String>), String> {
        let mut workspace = None;
        let mut cwd = None;
        let mut temp = None;
        let mut denied = Vec::new();
        let mut read_only = Vec::new();
        let mut network_allow = false;
        let mut index = 0;
        while index < args.len() {
            if args[index] == "--" {
                let command = args[index + 1..].to_vec();
                if command.is_empty() {
                    return Err("missing command after --".into());
                }
                return Ok((
                    LaunchPolicy {
                        workspace: workspace.clone().ok_or("missing --workspace")?,
                        cwd: cwd.or(workspace).ok_or("missing --cwd")?,
                        temp: temp.ok_or("missing --temp")?,
                        denied,
                        read_only,
                        network_allow,
                    },
                    command,
                ));
            }
            let flag = args[index].as_str();
            let value = args
                .get(index + 1)
                .ok_or_else(|| format!("missing value for {flag}"))?;
            match flag {
                "--workspace" => workspace = Some(canonical_policy_path(value)?),
                "--cwd" => cwd = Some(canonical_policy_path(value)?),
                "--temp" => temp = Some(canonical_policy_path(value)?),
                "--deny" => denied.push(canonical_policy_path(value)?),
                "--read-only" => read_only.push(canonical_policy_path(value)?),
                "--network" => match value.as_str() {
                    "allow" => network_allow = true,
                    "deny" => network_allow = false,
                    _ => return Err("--network must be allow or deny".into()),
                },
                _ => return Err(format!("unknown option: {flag}")),
            }
            index += 2;
        }
        Err("missing -- command separator".into())
    }

    fn canonical_policy_path(value: &str) -> Result<PathBuf, String> {
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err(format!("sandbox path must be absolute: {value}"));
        }
        dunce::canonicalize(&path).map_err(|error| format!("cannot canonicalize {value}: {error}"))
    }

    fn launch(policy: &LaunchPolicy, command: &[String]) -> Result<i32, String> {
        if !policy.cwd.starts_with(&policy.workspace) {
            return Err(format!(
                "working directory must stay inside workspace: {}",
                policy.cwd.display()
            ));
        }
        let executable = canonical_policy_path(&command[0])?;
        let mut read_only = policy.read_only.clone();
        if let Some(parent) = executable.parent() {
            read_only.push(parent.to_path_buf());
        }
        add_windows_runtime_roots(&mut read_only);
        dedupe_paths(&mut read_only);

        let legacy_spec = build_sandbox_spec(
            &[policy.workspace.clone(), policy.temp.clone()],
            &read_only,
            &policy.denied,
            policy.network_allow,
        );
        let cwd_w = wide_path(&policy.cwd);
        let command_line = wide(&windows_command_line(command));

        let stdin = std_handle(STD_INPUT_HANDLE)?;
        let stdout = std_handle(STD_OUTPUT_HANDLE)?;
        let stderr = std_handle(STD_ERROR_HANDLE)?;
        for handle in [stdin, stdout, stderr] {
            if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) }
                == 0
            {
                return Err(last_error("SetHandleInformation"));
            }
        }
        let startup = startup_info(stdin, stdout, stderr);

        let job = create_kill_on_close_job()?;
        let psec_spec = build_psec_spec(
            &[policy.workspace.clone(), policy.temp.clone()],
            &read_only,
            &policy.denied,
            policy.network_allow,
        );
        let mut psec_command_line = command_line.clone();
        let (process, _environment) = match launch_psec(
            &psec_spec,
            &mut psec_command_line,
            &cwd_w,
            &startup,
            &[stdin, stdout, stderr],
        ) {
            Ok(value) => value,
            Err(psec_error) => match load_create_api().and_then(|api| {
                let mut legacy_command_line = command_line.clone();
                launch_legacy(api, &legacy_spec, &mut legacy_command_line, &cwd_w, &startup)
            }) {
                Ok(value) => value,
                Err(legacy_error) => {
                    let mut appcontainer_command_line = command_line.clone();
                    launch_appcontainer(
                        policy,
                        &executable,
                        &read_only,
                        &mut appcontainer_command_line,
                        &cwd_w,
                        &startup,
                        &[stdin, stdout, stderr],
                    )
                }
                .map_err(|appcontainer_error| {
                    format!(
                        "PSEC unavailable ({psec_error}); legacy unavailable ({legacy_error}); AppContainer unavailable ({appcontainer_error})"
                    )
                })?,
            },
        };
        let process_handle = OwnedHandle(process.hProcess);
        let thread_handle = OwnedHandle(process.hThread);
        if unsafe { AssignProcessToJobObject(job.0, process_handle.0) } == 0 {
            unsafe { TerminateProcess(process_handle.0, ERROR_EXIT as u32) };
            return Err(last_error("AssignProcessToJobObject"));
        }
        if unsafe { ResumeThread(thread_handle.0) } == u32::MAX {
            unsafe { TerminateProcess(process_handle.0, ERROR_EXIT as u32) };
            return Err(last_error("ResumeThread"));
        }
        unsafe { WaitForSingleObject(process_handle.0, INFINITE) };
        let mut exit_code = ERROR_EXIT as u32;
        if unsafe { GetExitCodeProcess(process_handle.0, &mut exit_code) } == 0 {
            return Err(last_error("GetExitCodeProcess"));
        }
        drop(thread_handle);
        drop(process_handle);
        drop(job);
        Ok(exit_code as i32)
    }

    fn startup_info(stdin: HANDLE, stdout: HANDLE, stderr: HANDLE) -> STARTUPINFOW {
        let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = stdin;
        startup.hStdOutput = stdout;
        startup.hStdError = stderr;
        startup
    }

    fn launch_psec(
        spec: &[u8],
        command_line: &mut [u16],
        cwd: &[u16],
        startup: &STARTUPINFOW,
        inherited_handles: &[HANDLE],
    ) -> Result<(PROCESS_INFORMATION, Option<LaunchGuard>), String> {
        let module = load_system_dll("processmodel.dll")?;
        let create: CreateProcessSecurityEnvironment =
            load_export(module, "CreateProcessSecurityEnvironment")?;
        let query: QueryProcessSecurityEnvironmentSupport =
            load_export(module, "QueryProcessSecurityEnvironmentSupport")?;
        let close: CloseProcessSecurityEnvironment =
            load_export(module, "CloseProcessSecurityEnvironment")?;
        let mut support = 0u64;
        let query_result = unsafe { query(&mut support) };
        if query_result < 0 {
            return Err(format!(
                "QueryProcessSecurityEnvironmentSupport failed with HRESULT 0x{:08x}",
                query_result as u32
            ));
        }
        if support & PSEC_SUPPORT_FS_DENY == 0 {
            return Err("PSEC does not support denied paths".into());
        }
        let mut environment: HANDLE = ptr::null_mut();
        let create_result =
            unsafe { create(spec.as_ptr().cast(), spec.len() as u32, 0, &mut environment) };
        if create_result < 0 || environment.is_null() {
            return Err(format!(
                "CreateProcessSecurityEnvironment failed with HRESULT 0x{:08x}",
                create_result as u32
            ));
        }
        let guard = SecurityEnvironmentGuard {
            handle: environment,
            close,
        };
        let attributes = AttributeList::new(startup, environment, inherited_handles)?;
        let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let created = unsafe {
            CreateProcessW(
                ptr::null(),
                command_line.as_mut_ptr(),
                ptr::null(),
                ptr::null(),
                1,
                CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                ptr::null(),
                cwd.as_ptr(),
                &attributes.startup_info.StartupInfo,
                &mut process,
            )
        };
        if created == 0 {
            return Err(last_error("CreateProcessW(SecurityEnvironment)"));
        }
        Ok((process, Some(LaunchGuard::Security(guard))))
    }

    fn launch_legacy(
        api: CreateProcessInSandbox,
        spec: &[u8],
        command_line: &mut [u16],
        cwd: &[u16],
        startup: &STARTUPINFOW,
    ) -> Result<(PROCESS_INFORMATION, Option<LaunchGuard>), String> {
        let identity = format!(
            "Cairn.Sandbox.{}.{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let identity_w = wide(&identity);
        let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let created = unsafe {
            api(
                ptr::null(),
                command_line.as_mut_ptr(),
                ptr::null(),
                ptr::null(),
                1,
                CREATE_SUSPENDED | CREATE_NO_WINDOW,
                ptr::null(),
                cwd.as_ptr(),
                startup,
                identity_w.as_ptr(),
                spec.as_ptr(),
                spec.len() as u32,
                &mut process,
            )
        };
        if created == 0 {
            let error = unsafe { GetLastError() };
            cleanup_profile(&identity);
            return Err(format!(
                "Experimental_CreateProcessInSandbox failed with Win32 error {error}"
            ));
        }
        // The legacy profile is best-effort deleted after process creation; the
        // kernel token and policy remain valid for the running process tree.
        cleanup_profile(&identity);
        Ok((process, None))
    }

    fn launch_appcontainer(
        policy: &LaunchPolicy,
        executable: &Path,
        read_only: &[PathBuf],
        command_line: &mut [u16],
        cwd: &[u16],
        startup: &STARTUPINFOW,
        inherited_handles: &[HANDLE],
    ) -> Result<(PROCESS_INFORMATION, Option<LaunchGuard>), String> {
        if policy.network_allow {
            return Err("AppContainer fallback intentionally supports network=deny only".into());
        }
        let profile_name = format!(
            "Cairn.WindowsSandbox.{}.{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let sid = appcontainer_sid(&profile_name)?;
        let sid_string = match sid_string(sid.0) {
            Ok(value) => value,
            Err(error) => {
                cleanup_profile(&profile_name);
                return Err(error);
            }
        };
        let mut cleanup = AppContainerCleanup {
            profile_name,
            sid: sid_string.clone(),
            acl_roots: Vec::new(),
        };
        cleanup.acl_roots.push((policy.workspace.clone(), true));
        grant_acl(&policy.workspace, &sid_string, "M", true)?;
        if policy.temp != policy.workspace {
            cleanup.acl_roots.push((policy.temp.clone(), true));
            grant_acl(&policy.temp, &sid_string, "M", true)?;
        }
        if !is_windows_runtime_root(executable) {
            cleanup.acl_roots.push((executable.to_path_buf(), false));
            grant_acl(executable, &sid_string, "RX", false)?;
        }
        let executable_parent = executable.parent();
        for path in read_only {
            if !is_windows_runtime_root(path) {
                let recursive = executable_parent != Some(path.as_path());
                cleanup.acl_roots.push((path.clone(), recursive));
                grant_acl(path, &sid_string, "RX", recursive)?;
            }
        }
        for path in &policy.denied {
            cleanup.acl_roots.push((path.clone(), true));
            deny_acl(path, &sid_string)?;
        }

        let attributes = AppContainerAttributeList::new(startup, sid.0, inherited_handles)?;
        let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let created = unsafe {
            CreateProcessW(
                ptr::null(),
                command_line.as_mut_ptr(),
                ptr::null(),
                ptr::null(),
                1,
                CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                ptr::null(),
                cwd.as_ptr(),
                &attributes.startup_info.StartupInfo,
                &mut process,
            )
        };
        if created == 0 {
            return Err(last_error("CreateProcessW(AppContainer)"));
        }
        Ok((process, Some(LaunchGuard::AppContainer(cleanup))))
    }

    fn appcontainer_sid(profile_name: &str) -> Result<SidGuard, String> {
        let name = wide(profile_name);
        let display = wide("Cairn Windows Sandbox");
        let description = wide("Local process isolation for Cairn commands");
        let mut sid: PSID = ptr::null_mut();
        let created = unsafe {
            CreateAppContainerProfile(
                name.as_ptr(),
                display.as_ptr(),
                description.as_ptr(),
                ptr::null(),
                0,
                &mut sid,
            )
        };
        if created < 0 {
            sid = ptr::null_mut();
            let derived =
                unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid) };
            if derived < 0 || sid.is_null() {
                return Err(format!(
                    "DeriveAppContainerSidFromAppContainerName failed with HRESULT 0x{:08x}",
                    derived as u32
                ));
            }
        }
        if sid.is_null() {
            return Err("AppContainer profile returned a null SID".into());
        }
        Ok(SidGuard(sid))
    }

    fn sid_string(sid: PSID) -> Result<String, String> {
        let mut value: *mut u16 = ptr::null_mut();
        if unsafe { ConvertSidToStringSidW(sid, &mut value) } == 0 || value.is_null() {
            return Err(last_error("ConvertSidToStringSidW"));
        }
        let mut len = 0usize;
        unsafe {
            while *value.add(len) != 0 {
                len += 1;
            }
        }
        let result = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(value, len) });
        unsafe { LocalFree(value.cast()) };
        Ok(result)
    }

    fn grant_acl(path: &Path, sid: &str, rights: &str, recursive: bool) -> Result<(), String> {
        if acl_has_rights(path, sid, rights) {
            return Ok(());
        }
        let principal = if recursive {
            format!("*{sid}:(OI)(CI){rights}")
        } else {
            format!("*{sid}:{rights}")
        };
        let mut command = std::process::Command::new(system_executable("icacls.exe"));
        command.arg(path).arg("/grant").arg(principal);
        if recursive {
            command.args(["/T", "/C", "/Q"]);
        }
        command.creation_flags(CREATE_NO_WINDOW);
        let output = command
            .output()
            .map_err(|error| format!("icacls grant failed to start: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "icacls grant failed for {} (exit {:?}): {}",
                path.display(),
                output.status.code(),
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(())
    }

    fn acl_has_rights(path: &Path, sid: &str, rights: &str) -> bool {
        let Ok(output) = std::process::Command::new(system_executable("icacls.exe"))
            .arg(path)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        else {
            return false;
        };
        if !output.status.success() {
            return false;
        }
        let text = String::from_utf8_lossy(&output.stdout).to_lowercase();
        text.contains(&sid.to_lowercase()) && text.contains(&format!("({})", rights.to_lowercase()))
    }

    fn deny_acl(path: &Path, sid: &str) -> Result<(), String> {
        let principal = format!("*{sid}:(OI)(CI)F");
        let output = std::process::Command::new(system_executable("icacls.exe"))
            .arg(path)
            .arg("/deny")
            .arg(principal)
            .args(["/T", "/C", "/Q"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|error| format!("icacls deny failed to start: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "icacls deny failed for {} (exit {:?}): {}",
                path.display(),
                output.status.code(),
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(())
    }

    fn remove_acl(path: &Path, sid: &str, recursive: bool) {
        let principal = format!("*{sid}");
        for flag in ["/remove:g", "/remove:d"] {
            let mut command = std::process::Command::new(system_executable("icacls.exe"));
            command.arg(path).arg(flag).arg(&principal);
            if recursive {
                command.args(["/T", "/C", "/Q"]);
            }
            let _ = command.creation_flags(CREATE_NO_WINDOW).output();
        }
    }

    fn system_executable(name: &str) -> PathBuf {
        PathBuf::from(std::env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into()))
            .join("System32")
            .join(name)
    }

    fn is_windows_runtime_root(path: &Path) -> bool {
        let normalized = path.to_string_lossy().to_lowercase();
        let windows = std::env::var("WINDIR")
            .unwrap_or_else(|_| "C:\\Windows".into())
            .to_lowercase();
        normalized == windows || normalized.starts_with(&(windows + "\\"))
    }

    impl AppContainerAttributeList {
        fn new(
            startup: &STARTUPINFOW,
            sid: PSID,
            inherited_handles: &[HANDLE],
        ) -> Result<Self, String> {
            let attribute_count = if inherited_handles.is_empty() { 1 } else { 2 };
            let mut bytes = 0usize;
            unsafe {
                InitializeProcThreadAttributeList(ptr::null_mut(), attribute_count, 0, &mut bytes)
            };
            if bytes == 0 {
                return Err(last_error(
                    "InitializeProcThreadAttributeList(AppContainer size)",
                ));
            }
            let mut storage = vec![0usize; bytes.div_ceil(std::mem::size_of::<usize>())];
            let list = storage.as_mut_ptr().cast();
            if unsafe { InitializeProcThreadAttributeList(list, attribute_count, 0, &mut bytes) }
                == 0
            {
                return Err(last_error(
                    "InitializeProcThreadAttributeList(AppContainer)",
                ));
            }
            let capabilities = Box::new(SECURITY_CAPABILITIES {
                AppContainerSid: sid,
                Capabilities: ptr::null_mut(),
                CapabilityCount: 0,
                Reserved: 0,
            });
            if unsafe {
                UpdateProcThreadAttribute(
                    list,
                    0,
                    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                    (&*capabilities as *const SECURITY_CAPABILITIES).cast(),
                    std::mem::size_of::<SECURITY_CAPABILITIES>(),
                    ptr::null_mut(),
                    ptr::null(),
                )
            } == 0
            {
                unsafe { DeleteProcThreadAttributeList(list) };
                return Err(last_error(
                    "UpdateProcThreadAttribute(SecurityCapabilities)",
                ));
            }
            let inherited = inherited_handles.to_vec().into_boxed_slice();
            if !inherited.is_empty()
                && unsafe {
                    UpdateProcThreadAttribute(
                        list,
                        0,
                        PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                        inherited.as_ptr().cast(),
                        std::mem::size_of_val(&*inherited),
                        ptr::null_mut(),
                        ptr::null(),
                    )
                } == 0
            {
                unsafe { DeleteProcThreadAttributeList(list) };
                return Err(last_error(
                    "UpdateProcThreadAttribute(AppContainer HandleList)",
                ));
            }
            let mut startup_info: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
            startup_info.StartupInfo = *startup;
            startup_info.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            startup_info.lpAttributeList = list;
            Ok(Self {
                _storage: storage,
                list,
                _capabilities: capabilities,
                _inherited: inherited,
                startup_info,
            })
        }
    }

    impl AttributeList {
        fn new(
            startup: &STARTUPINFOW,
            environment: HANDLE,
            inherited_handles: &[HANDLE],
        ) -> Result<Self, String> {
            let attribute_count = if inherited_handles.is_empty() { 1 } else { 2 };
            let mut bytes = 0usize;
            unsafe {
                InitializeProcThreadAttributeList(ptr::null_mut(), attribute_count, 0, &mut bytes)
            };
            if bytes == 0 {
                return Err(last_error("InitializeProcThreadAttributeList(size)"));
            }
            let mut storage = vec![0usize; bytes.div_ceil(std::mem::size_of::<usize>())];
            let list = storage.as_mut_ptr().cast();
            if unsafe { InitializeProcThreadAttributeList(list, attribute_count, 0, &mut bytes) }
                == 0
            {
                return Err(last_error("InitializeProcThreadAttributeList"));
            }
            let environment = Box::new(environment);
            if unsafe {
                UpdateProcThreadAttribute(
                    list,
                    0,
                    PROC_THREAD_ATTRIBUTE_SECURITY_ENVIRONMENT,
                    (&*environment as *const HANDLE).cast(),
                    std::mem::size_of::<HANDLE>(),
                    ptr::null_mut(),
                    ptr::null(),
                )
            } == 0
            {
                unsafe { DeleteProcThreadAttributeList(list) };
                return Err(last_error("UpdateProcThreadAttribute(SecurityEnvironment)"));
            }
            let inherited = inherited_handles.to_vec().into_boxed_slice();
            if !inherited.is_empty()
                && unsafe {
                    UpdateProcThreadAttribute(
                        list,
                        0,
                        PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                        inherited.as_ptr().cast(),
                        std::mem::size_of_val(&*inherited),
                        ptr::null_mut(),
                        ptr::null(),
                    )
                } == 0
            {
                unsafe { DeleteProcThreadAttributeList(list) };
                return Err(last_error("UpdateProcThreadAttribute(HandleList)"));
            }
            let mut startup_info: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
            startup_info.StartupInfo = *startup;
            startup_info.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            startup_info.lpAttributeList = list;
            Ok(Self {
                _storage: storage,
                list,
                _environment: environment,
                _inherited: inherited,
                startup_info,
            })
        }
    }

    fn load_export<T: Copy>(module: HMODULE, name: &str) -> Result<T, String> {
        let name_c = CString::new(name).map_err(|_| "invalid export name")?;
        let proc = unsafe { GetProcAddress(module, name_c.as_ptr() as *const u8) }
            .ok_or_else(|| format!("{name} is unavailable"))?;
        if std::mem::size_of::<T>() != std::mem::size_of_val(&proc) {
            return Err(format!("invalid function pointer size for {name}"));
        }
        Ok(unsafe { std::mem::transmute_copy(&proc) })
    }

    fn build_sandbox_spec(
        read_write: &[PathBuf],
        read_only: &[PathBuf],
        denied: &[PathBuf],
        network_allow: bool,
    ) -> Vec<u8> {
        let mut builder = FlatBufferBuilder::with_capacity(2048);
        let version = builder.create_string(SANDBOX_SPEC_VERSION);
        let capabilities = network_allow.then(|| {
            builder.create_string("internetClient,internetClientServer,privateNetworkClientServer")
        });
        let rw_strings: Vec<_> = read_write
            .iter()
            .map(|path| builder.create_string(&path.to_string_lossy()))
            .collect();
        let rw = builder.create_vector(&rw_strings);
        let ro_strings: Vec<_> = read_only
            .iter()
            .map(|path| builder.create_string(&path.to_string_lossy()))
            .collect();
        let ro = builder.create_vector(&ro_strings);
        let denied_strings: Vec<_> = denied
            .iter()
            .map(|path| builder.create_string(&path.to_string_lossy()))
            .collect();
        let deny = builder.create_vector(&denied_strings);

        let egress_start = builder.start_table();
        // deny = 0 is the schema default. Writing the slot explicitly makes the
        // intended network posture clear in this hand-maintained encoder.
        builder.push_slot::<i8>(
            ENDPOINT_DEFAULT_ACTION,
            if network_allow { 1 } else { 0 },
            0,
        );
        let egress = builder.end_table(egress_start);
        let network_start = builder.start_table();
        builder.push_slot_always(NETWORK_EGRESS, egress);
        let network = builder.end_table(network_start);

        let root_start = builder.start_table();
        builder.push_slot_always::<WIPOffset<_>>(SBOX_VERSION, version);
        builder.push_slot::<bool>(SBOX_APP_CONTAINER, true, false);
        builder.push_slot::<bool>(SBOX_DISALLOW_WIN32K, false, false);
        builder.push_slot::<u64>(SBOX_UI_RESTRICTIONS, ALL_UI_RESTRICTIONS, 0);
        builder.push_slot::<bool>(SBOX_LEAST_PRIVILEGE, true, false);
        if let Some(capabilities) = capabilities {
            builder.push_slot_always::<WIPOffset<_>>(SBOX_CAPABILITIES, capabilities);
        }
        builder.push_slot_always::<WIPOffset<_>>(SBOX_FS_READ_WRITE, rw);
        builder.push_slot_always::<WIPOffset<_>>(SBOX_FS_READ_ONLY, ro);
        builder.push_slot_always(SBOX_NETWORK_POLICY, network);
        if !denied.is_empty() {
            builder.push_slot_always::<WIPOffset<_>>(SBOX_FS_DENY, deny);
        }
        let root = builder.end_table(root_start);
        builder.finish(root, Some("SBOX"));
        builder.finished_data().to_vec()
    }

    fn build_psec_spec(
        read_write: &[PathBuf],
        read_only: &[PathBuf],
        denied: &[PathBuf],
        network_allow: bool,
    ) -> Vec<u8> {
        let mut builder = FlatBufferBuilder::with_capacity(2048);
        let capabilities = network_allow.then(|| {
            builder.create_string("internetClient,internetClientServer,privateNetworkClientServer")
        });
        let rw_strings: Vec<_> = read_write
            .iter()
            .map(|path| builder.create_string(&path.to_string_lossy()))
            .collect();
        let rw = builder.create_vector(&rw_strings);
        let ro_strings: Vec<_> = read_only
            .iter()
            .map(|path| builder.create_string(&path.to_string_lossy()))
            .collect();
        let ro = builder.create_vector(&ro_strings);
        let denied_strings: Vec<_> = denied
            .iter()
            .map(|path| builder.create_string(&path.to_string_lossy()))
            .collect();
        let deny = builder.create_vector(&denied_strings);

        let egress_start = builder.start_table();
        builder.push_slot::<i8>(
            ENDPOINT_DEFAULT_ACTION,
            if network_allow { 1 } else { 0 },
            0,
        );
        let egress = builder.end_table(egress_start);
        let network_start = builder.start_table();
        builder.push_slot_always(NETWORK_EGRESS, egress);
        let network = builder.end_table(network_start);
        let version = SchemaVersion::new(1, 0);

        let root_start = builder.start_table();
        builder.push_slot_always::<&SchemaVersion>(PSEC_VERSION, &version);
        if let Some(capabilities) = capabilities {
            builder.push_slot_always::<WIPOffset<_>>(PSEC_CAPABILITIES, capabilities);
        }
        builder.push_slot::<bool>(PSEC_DISALLOW_WIN32K, false, false);
        builder.push_slot::<u64>(PSEC_UI_RESTRICTIONS, ALL_UI_RESTRICTIONS, 0);
        builder.push_slot_always::<WIPOffset<_>>(PSEC_FS_READ_WRITE, rw);
        builder.push_slot_always::<WIPOffset<_>>(PSEC_FS_READ_ONLY, ro);
        if !denied.is_empty() {
            builder.push_slot_always::<WIPOffset<_>>(PSEC_FS_DENY, deny);
        }
        builder.push_slot_always(PSEC_NETWORK_POLICY, network);
        let root = builder.end_table(root_start);
        builder.finish(root, Some("PSEC"));
        builder.finished_data().to_vec()
    }

    fn create_kill_on_close_job() -> Result<OwnedHandle, String> {
        let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if handle.is_null() {
            return Err(last_error("CreateJobObjectW"));
        }
        let job = OwnedHandle(handle);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                std::mem::size_of_val(&limits) as u32,
            )
        };
        if ok == 0 {
            return Err(last_error("SetInformationJobObject"));
        }
        Ok(job)
    }

    fn load_create_api() -> Result<CreateProcessInSandbox, String> {
        let module = load_system_dll("processmodel.dll")?;
        load_export(module, "Experimental_CreateProcessInSandbox")
    }

    fn cleanup_profile(identity: &str) {
        let Ok(module) = load_system_dll("userenv.dll") else {
            return;
        };
        let name = CString::new("DeleteAppContainerProfile").unwrap();
        let Some(proc) = (unsafe { GetProcAddress(module, name.as_ptr() as *const u8) }) else {
            return;
        };
        let delete: DeleteAppContainerProfile = unsafe { std::mem::transmute(proc) };
        let identity = wide(identity);
        unsafe { delete(identity.as_ptr()) };
    }

    fn load_system_dll(name: &str) -> Result<HMODULE, String> {
        let name = wide(name);
        let module =
            unsafe { LoadLibraryExW(name.as_ptr(), ptr::null_mut(), LOAD_LIBRARY_SEARCH_SYSTEM32) };
        if module.is_null() {
            Err(last_error("LoadLibraryExW"))
        } else {
            Ok(module)
        }
    }

    fn add_windows_runtime_roots(paths: &mut Vec<PathBuf>) {
        if let Some(windows) = std::env::var_os("WINDIR") {
            let windows = PathBuf::from(windows);
            paths.push(windows.clone());
            paths.push(windows.join("System32"));
        }
    }

    fn dedupe_paths(paths: &mut Vec<PathBuf>) {
        paths.sort_by_key(|path| path.to_string_lossy().to_lowercase());
        paths.dedup_by(|left, right| {
            left.to_string_lossy()
                .eq_ignore_ascii_case(&right.to_string_lossy())
        });
    }

    fn self_test() -> Result<i32, String> {
        let root = std::env::temp_dir().join(format!(
            "cairn-sandbox-probe-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let workspace = root.join("workspace");
        let outside = root.join("outside");
        fs::create_dir_all(&workspace).map_err(|error| error.to_string())?;
        fs::create_dir_all(&outside).map_err(|error| error.to_string())?;
        fs::write(outside.join("secret.txt"), "secret").map_err(|error| error.to_string())?;
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let policy = LaunchPolicy {
            workspace: dunce::canonicalize(&workspace).map_err(|error| error.to_string())?,
            cwd: dunce::canonicalize(&workspace).map_err(|error| error.to_string())?,
            temp: dunce::canonicalize(&workspace).map_err(|error| error.to_string())?,
            denied: vec![dunce::canonicalize(&outside).map_err(|error| error.to_string())?],
            read_only: vec![executable
                .parent()
                .unwrap_or(Path::new("C:\\"))
                .to_path_buf()],
            network_allow: false,
        };
        let command = vec![
            executable.to_string_lossy().into_owned(),
            "--self-test-child".into(),
            workspace.to_string_lossy().into_owned(),
            outside.to_string_lossy().into_owned(),
            port.to_string(),
        ];
        let result = launch(&policy, &command);
        drop(listener);
        let allowed_exists = workspace.join("allowed.txt").exists();
        let escaped_exists =
            outside.join("escaped.txt").exists() || outside.join("child-escaped.txt").exists();
        let _ = fs::remove_dir_all(&root);
        let exit = result?;
        if exit != 0 || !allowed_exists || escaped_exists {
            return Err(format!(
                "negative self-test failed (exit={exit}, allowed={allowed_exists}, escaped={escaped_exists})"
            ));
        }
        println!("{HELPER_VERSION}: self-test passed");
        Ok(0)
    }

    fn self_test_child(args: &[String]) -> Result<i32, String> {
        if args.len() != 3 {
            return Err("invalid self-test child arguments".into());
        }
        let workspace = PathBuf::from(&args[0]);
        let outside = PathBuf::from(&args[1]);
        let port: u16 = args[2].parse().map_err(|_| "invalid self-test port")?;
        if fs::write(workspace.join("allowed.txt"), "ok").is_err() {
            return Ok(CHILD_POLICY_FAILURE);
        }
        if fs::read_to_string(outside.join("secret.txt")).is_ok()
            || fs::write(outside.join("escaped.txt"), "escape").is_ok()
        {
            return Ok(CHILD_POLICY_FAILURE);
        }
        if TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}")
                .parse()
                .map_err(|_| "invalid socket")?,
            Duration::from_millis(750),
        )
        .is_ok()
        {
            return Ok(CHILD_POLICY_FAILURE);
        }
        let status =
            std::process::Command::new(std::env::current_exe().map_err(|error| error.to_string())?)
                .arg("--escape-child")
                .arg(&outside)
                .status()
                .map_err(|error| format!("descendant probe failed to start: {error}"))?;
        if status.success() || outside.join("child-escaped.txt").exists() {
            return Ok(CHILD_POLICY_FAILURE);
        }
        Ok(0)
    }

    fn escape_child(args: &[String]) -> Result<i32, String> {
        let outside = args.first().ok_or("missing escape path")?;
        Ok(
            if fs::write(Path::new(outside).join("child-escaped.txt"), "escape").is_ok() {
                0
            } else {
                1
            },
        )
    }

    fn std_handle(kind: u32) -> Result<HANDLE, String> {
        let handle = unsafe { GetStdHandle(kind) };
        if handle.is_null() || handle == (-1isize) as HANDLE {
            Err(last_error("GetStdHandle"))
        } else {
            Ok(handle)
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(Some(0))
            .collect()
    }

    fn wide_path(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    fn windows_command_line(args: &[String]) -> String {
        args.iter()
            .map(|arg| quote_windows_arg(arg))
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn quote_windows_arg(arg: &str) -> String {
        if !arg.is_empty()
            && !arg
                .bytes()
                .any(|byte| matches!(byte, b' ' | b'\t' | b'\n' | b'\x0b' | b'\"'))
        {
            return arg.to_string();
        }
        let mut out = String::from("\"");
        let mut slashes = 0;
        for ch in arg.chars() {
            if ch == '\\' {
                slashes += 1;
            } else if ch == '"' {
                out.push_str(&"\\".repeat(slashes * 2 + 1));
                out.push('"');
                slashes = 0;
            } else {
                out.push_str(&"\\".repeat(slashes));
                slashes = 0;
                out.push(ch);
            }
        }
        out.push_str(&"\\".repeat(slashes * 2));
        out.push('"');
        out
    }

    fn last_error(operation: &str) -> String {
        let code = unsafe { GetLastError() };
        format!("{operation} failed with Win32 error {code}")
    }
}

#[cfg(windows)]
fn main() {
    windows_main::main();
}
