param(
    [Parameter(Mandatory=$true)][string]$TargetBin,
    [Parameter(Mandatory=$false)][string]$ArgsFile,
    [Parameter(Mandatory=$false)][string]$ArgsBase64
)

$jobTypeDef = @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class KernelJobObject {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryLimit;
        public UIntPtr PeakJobMemoryLimit;
    }

    public static bool InitializeCurrentProcessJob() {
        IntPtr hJob = CreateJobObject(IntPtr.Zero, null);
        if (hJob == IntPtr.Zero) return false;

        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr pInfo = Marshal.AllocHGlobal(length);
        try {
            Marshal.StructureToPtr(info, pInfo, false);
            if (!SetInformationJobObject(hJob, 9, pInfo, (uint)length)) {
                return false;
            }
            return AssignProcessToJobObject(hJob, Process.GetCurrentProcess().Handle);
        } finally {
            Marshal.FreeHGlobal(pInfo);
        }
    }
}
"@

try {
    Add-Type -TypeDefinition $jobTypeDef -ErrorAction Stop
} catch {
    # If type is already loaded in current session, proceed
}

$ok = [KernelJobObject]::InitializeCurrentProcessJob()
if (-not $ok) {
    [Console]::Error.WriteLine("Failed to assign process to Windows Job Object")
    exit 1
}

$argList = @()
if ($ArgsBase64) {
    $rawJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($ArgsBase64))
    $argList = ConvertFrom-Json $rawJson
} elseif ($ArgsFile -and (Test-Path $ArgsFile)) {
    try {
        $rawJson = Get-Content -Raw -Path $ArgsFile
        $argList = ConvertFrom-Json $rawJson
    } finally {
        Remove-Item -Force -Path $ArgsFile -ErrorAction SilentlyContinue
    }
}

& $TargetBin @argList
exit $LASTEXITCODE
