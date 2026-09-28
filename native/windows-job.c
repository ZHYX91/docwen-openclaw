typedef void *HANDLE;
typedef void *LPVOID;
typedef const void *LPCVOID;
typedef unsigned long DWORD;
typedef unsigned int UINT;
typedef int BOOL;
typedef unsigned short WORD;
typedef unsigned long long ULONG_PTR;
typedef ULONG_PTR SIZE_T;
typedef long long LONGLONG;
typedef unsigned long long ULONGLONG;
typedef unsigned short WCHAR;
typedef WCHAR *LPWSTR;
typedef const WCHAR *LPCWSTR;
typedef unsigned char BYTE;

#define WINAPI __stdcall
#define TRUE 1
#define FALSE 0
#define INVALID_HANDLE_VALUE ((HANDLE)(long long)-1)
#define STD_INPUT_HANDLE ((DWORD)-10)
#define STD_OUTPUT_HANDLE ((DWORD)-11)
#define STD_ERROR_HANDLE ((DWORD)-12)
#define HANDLE_FLAG_INHERIT 0x00000001u
#define STARTF_USESTDHANDLES 0x00000100u
#define CREATE_SUSPENDED 0x00000004u
#define CREATE_UNICODE_ENVIRONMENT 0x00000400u
#define CREATE_NO_WINDOW 0x08000000u
#define JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE 0x00002000u
#define JobObjectExtendedLimitInformation 9u
#define INFINITE 0xffffffffu
#define WAIT_OBJECT_0 0u
#define WRAPPER_ERROR 125u
#define MAX_TARGET 16384u
#define MAX_COMMAND 32767u

__declspec(dllimport) HANDLE WINAPI CreateJobObjectW(LPVOID, LPCWSTR);
__declspec(dllimport) BOOL WINAPI SetInformationJobObject(HANDLE, int, LPVOID, DWORD);
__declspec(dllimport) BOOL WINAPI AssignProcessToJobObject(HANDLE, HANDLE);
__declspec(dllimport) BOOL WINAPI TerminateJobObject(HANDLE, UINT);
__declspec(dllimport) BOOL WINAPI CreateProcessW(LPCWSTR, LPWSTR, LPVOID, LPVOID, BOOL, DWORD, LPVOID, LPCWSTR, LPVOID, LPVOID);
__declspec(dllimport) DWORD WINAPI ResumeThread(HANDLE);
__declspec(dllimport) DWORD WINAPI WaitForSingleObject(HANDLE, DWORD);
__declspec(dllimport) BOOL WINAPI GetExitCodeProcess(HANDLE, DWORD *);
__declspec(dllimport) BOOL WINAPI CloseHandle(HANDLE);
__declspec(dllimport) HANDLE WINAPI GetStdHandle(DWORD);
__declspec(dllimport) BOOL WINAPI SetStdHandle(DWORD, HANDLE);
__declspec(dllimport) BOOL WINAPI SetHandleInformation(HANDLE, DWORD, DWORD);
__declspec(dllimport) DWORD WINAPI GetEnvironmentVariableW(LPCWSTR, LPWSTR, DWORD);
__declspec(dllimport) BOOL WINAPI SetEnvironmentVariableW(LPCWSTR, LPCWSTR);
__declspec(dllimport) void WINAPI ExitProcess(UINT);

struct IO_COUNTERS {
  ULONGLONG ReadOperationCount;
  ULONGLONG WriteOperationCount;
  ULONGLONG OtherOperationCount;
  ULONGLONG ReadTransferCount;
  ULONGLONG WriteTransferCount;
  ULONGLONG OtherTransferCount;
};

struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
  LONGLONG PerProcessUserTimeLimit;
  LONGLONG PerJobUserTimeLimit;
  DWORD LimitFlags;
  SIZE_T MinimumWorkingSetSize;
  SIZE_T MaximumWorkingSetSize;
  DWORD ActiveProcessLimit;
  ULONG_PTR Affinity;
  DWORD PriorityClass;
  DWORD SchedulingClass;
};

struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
  struct IO_COUNTERS IoInfo;
  SIZE_T ProcessMemoryLimit;
  SIZE_T JobMemoryLimit;
  SIZE_T PeakProcessMemoryUsed;
  SIZE_T PeakJobMemoryUsed;
};

struct STARTUPINFOW {
  DWORD cb;
  LPWSTR lpReserved;
  LPWSTR lpDesktop;
  LPWSTR lpTitle;
  DWORD dwX;
  DWORD dwY;
  DWORD dwXSize;
  DWORD dwYSize;
  DWORD dwXCountChars;
  DWORD dwYCountChars;
  DWORD dwFillAttribute;
  DWORD dwFlags;
  WORD wShowWindow;
  WORD cbReserved2;
  BYTE *lpReserved2;
  HANDLE hStdInput;
  HANDLE hStdOutput;
  HANDLE hStdError;
};

struct PROCESS_INFORMATION {
  HANDLE hProcess;
  HANDLE hThread;
  DWORD dwProcessId;
  DWORD dwThreadId;
};

_Static_assert(sizeof(struct JOBOBJECT_BASIC_LIMIT_INFORMATION) == 64, "basic limit size");
_Static_assert(sizeof(struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION) == 144, "extended limit size");
_Static_assert(sizeof(struct STARTUPINFOW) == 104, "startup size");
_Static_assert(sizeof(struct PROCESS_INFORMATION) == 24, "process info size");

static WCHAR target[MAX_TARGET];
static WCHAR commandLine[MAX_COMMAND];
static const WCHAR targetVariable[] = {'O','P','E','N','C','L','A','W','_','D','O','C','W','E','N','_','J','O','B','_','T','A','R','G','E','T',0};
static struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
static struct STARTUPINFOW startup;
static struct PROCESS_INFORMATION processInfo;

static void fail(HANDLE job, HANDLE process, HANDLE thread) {
  if (thread && thread != INVALID_HANDLE_VALUE) CloseHandle(thread);
  if (process && process != INVALID_HANDLE_VALUE) CloseHandle(process);
  if (job && job != INVALID_HANDLE_VALUE) {
    TerminateJobObject(job, WRAPPER_ERROR);
    CloseHandle(job);
  }
  ExitProcess(WRAPPER_ERROR);
}

static BOOL build_command_line(DWORD targetLength) {
  DWORD index = 0;
  if (targetLength + 16u >= MAX_COMMAND) return FALSE;
  commandLine[index++] = L'\"';
  for (DWORD i = 0; i < targetLength; i++) {
    if (target[i] == L'\"' || target[i] == 0) return FALSE;
    commandLine[index++] = target[i];
  }
  commandLine[index++] = L'"';
  commandLine[index++] = L' ';
  commandLine[index++] = L's';
  commandLine[index++] = L'e';
  commandLine[index++] = L'r';
  commandLine[index++] = L'v';
  commandLine[index++] = L'e';
  commandLine[index++] = L' ';
  commandLine[index++] = L'-';
  commandLine[index++] = L'-';
  commandLine[index++] = L's';
  commandLine[index++] = L't';
  commandLine[index++] = L'd';
  commandLine[index++] = L'i';
  commandLine[index++] = L'o';
  commandLine[index] = 0;
  return TRUE;
}

void entry(void) {
  DWORD targetLength = GetEnvironmentVariableW(targetVariable, target, MAX_TARGET);
  if (targetLength == 0 || targetLength >= MAX_TARGET || !build_command_line(targetLength)) {
    ExitProcess(WRAPPER_ERROR);
  }
  if (!SetEnvironmentVariableW(targetVariable, (LPCWSTR)0)) ExitProcess(WRAPPER_ERROR);

  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  HANDLE error = GetStdHandle(STD_ERROR_HANDLE);
  if (!input || input == INVALID_HANDLE_VALUE || !output || output == INVALID_HANDLE_VALUE || !error || error == INVALID_HANDLE_VALUE) {
    ExitProcess(WRAPPER_ERROR);
  }
  if (!SetHandleInformation(input, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) ||
      !SetHandleInformation(output, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) ||
      !SetHandleInformation(error, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) {
    ExitProcess(WRAPPER_ERROR);
  }

  HANDLE job = CreateJobObjectW((LPVOID)0, (LPCWSTR)0);
  if (!job || job == INVALID_HANDLE_VALUE) ExitProcess(WRAPPER_ERROR);
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, (DWORD)sizeof(limits))) {
    fail(job, (HANDLE)0, (HANDLE)0);
  }

  startup.cb = (DWORD)sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = input;
  startup.hStdOutput = output;
  startup.hStdError = error;
  if (!CreateProcessW(
        target,
        commandLine,
        (LPVOID)0,
        (LPVOID)0,
        TRUE,
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
        (LPVOID)0,
        (LPCWSTR)0,
        &startup,
        &processInfo)) {
    fail(job, (HANDLE)0, (HANDLE)0);
  }
  if (!AssignProcessToJobObject(job, processInfo.hProcess)) {
    TerminateJobObject(job, WRAPPER_ERROR);
    fail(job, processInfo.hProcess, processInfo.hThread);
  }
  if (ResumeThread(processInfo.hThread) == 0xffffffffu) {
    TerminateJobObject(job, WRAPPER_ERROR);
    fail(job, processInfo.hProcess, processInfo.hThread);
  }
  CloseHandle(processInfo.hThread);
  processInfo.hThread = (HANDLE)0;

  /* Leave the Machine process as the only stdin reader so a closed peer is
     observable by the Node parent as a broken pipe. */
  CloseHandle(input);
  SetStdHandle(STD_INPUT_HANDLE, INVALID_HANDLE_VALUE);

  if (WaitForSingleObject(processInfo.hProcess, INFINITE) != WAIT_OBJECT_0) {
    TerminateJobObject(job, WRAPPER_ERROR);
    fail(job, processInfo.hProcess, (HANDLE)0);
  }
  DWORD exitCode = WRAPPER_ERROR;
  if (!GetExitCodeProcess(processInfo.hProcess, &exitCode)) exitCode = WRAPPER_ERROR;
  CloseHandle(processInfo.hProcess);
  processInfo.hProcess = (HANDLE)0;

  /* A direct child may have exited while descendants still hold inherited
     stdio. Job ownership survives that root exit, so terminate those members
     before the wrapper itself releases its stdout/stderr handles. */
  if (!TerminateJobObject(job, exitCode == 0 ? WRAPPER_ERROR : exitCode)) {
    fail(job, (HANDLE)0, (HANDLE)0);
  }
  CloseHandle(job);
  ExitProcess(exitCode);
}
