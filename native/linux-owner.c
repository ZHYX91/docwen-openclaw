/* Linux-only Machine owner. No process-name/procfs scans and no detached PID
 * authority crosses the Node boundary. See native/README.md for invariants. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define CONTROL 3
#define CLEANUP_MS 2000
#define START_MS 5000

struct report { int kind; int value; };
enum { GROUP_READY = 1, ROOT_EXIT, EXEC_ERROR };

static long long now_ms(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) _exit(125);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static int send_report(int fd, int kind, int value) {
    struct report message = { kind, value };
    ssize_t n;
    do { n = write(fd, &message, sizeof(message)); } while (n < 0 && errno == EINTR);
    return n == sizeof(message) ? 0 : -1;
}

static void status_line(const char *kind, int value) {
    char buffer[80];
    int n = snprintf(buffer, sizeof(buffer), "DWO1 %s %d\n", kind, value);
    if (n > 0 && n < (int)sizeof(buffer)) {
        ssize_t sent;
        do { sent = write(CONTROL, buffer, (size_t)n); } while (sent < 0 && errno == EINTR);
        if (sent != n) return;
    }
}

static int gate(int fd, int timeout_ms) {
    struct pollfd item = { .fd = fd, .events = POLLIN };
    int result;
    do { result = poll(&item, 1, timeout_ms); } while (result < 0 && errno == EINTR);
    char byte = 0;
    return result > 0 && read(fd, &byte, 1) == 1 && byte == 'A';
}

static void guardian_lost_parent(int unused) {
    (void)unused;
    /* Installed only after setsid: this process itself pins this group. */
    (void)kill(0, SIGKILL);
    _exit(125);
}

static void guardian(int channel, pid_t parent, const char *target) {
    close(CONTROL);
    if (setsid() < 0) _exit(125);
    struct sigaction action = {0};
    action.sa_handler = guardian_lost_parent;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGUSR1, &action, NULL) != 0 || prctl(PR_SET_PDEATHSIG, SIGUSR1) != 0)
        _exit(125);
    if (getppid() != parent) guardian_lost_parent(0);
    if (send_report(channel, GROUP_READY, 0) != 0 || !gate(channel, START_MS))
        guardian_lost_parent(0);

    int start[2], exec_error[2];
    if (pipe2(start, O_CLOEXEC) != 0) _exit(125);
    if (pipe2(exec_error, O_CLOEXEC) != 0) _exit(125);
    pid_t root = fork();
    if (root < 0) _exit(125);
    if (root == 0) {
        close(channel);
        close(start[1]);
        close(exec_error[0]);
        if (!gate(start[0], START_MS)) _exit(125);
        close(start[0]);
        struct sigaction reset = {0};
        reset.sa_handler = SIG_DFL;
        sigemptyset(&reset.sa_mask);
        sigaction(SIGUSR1, &reset, NULL);
        sigaction(SIGPIPE, &reset, NULL);
        sigaction(SIGCHLD, &reset, NULL);
        sigset_t empty;
        sigemptyset(&empty);
        sigprocmask(SIG_SETMASK, &empty, NULL);
        char *const args[] = { (char *)target, "serve", "--stdio", NULL };
        execv(target, args);
        int failure = errno;
        if (write(exec_error[1], &failure, sizeof(failure)) != sizeof(failure)) _exit(127);
        _exit(127);
    }

    close(start[0]);
    close(exec_error[1]);
    /* Both supervisors release ALL business descriptors before root exec.
     * In particular no duplicate reader can hide a real stdin EPIPE. */
    close(STDIN_FILENO);
    close(STDOUT_FILENO);
    close(STDERR_FILENO);
    if (write(start[1], "A", 1) != 1) guardian_lost_parent(0);
    close(start[1]);
    int failure = 0;
    ssize_t count;
    do { count = read(exec_error[0], &failure, sizeof(failure)); } while (count < 0 && errno == EINTR);
    close(exec_error[0]);
    if (count != 0) {
        if (send_report(channel, EXEC_ERROR, count == sizeof(failure) ? failure : EIO) != 0)
            guardian_lost_parent(0);
        for (;;) pause();
    }
    int result = 0;
    pid_t waited;
    do { waited = waitpid(root, &result, 0); } while (waited < 0 && errno == EINTR);
    if (waited != root || send_report(channel, ROOT_EXIT, result) != 0)
        guardian_lost_parent(0);
    /* Never release the group identity here. W will perform its final group
     * signal while we are alive or still its unreaped direct child. */
    for (;;) pause();
}

int main(int argc, char **argv) {
    if (argc != 2 || argv[1][0] != '/') return 125;
    sigset_t empty;
    sigemptyset(&empty);
    if (sigprocmask(SIG_SETMASK, &empty, NULL) != 0) return 125;
    struct sigaction reset = {0};
    reset.sa_handler = SIG_DFL;
    sigemptyset(&reset.sa_mask);
    if (sigaction(SIGCHLD, &reset, NULL) != 0) return 125;
    struct sigaction ignored = reset;
    ignored.sa_handler = SIG_IGN;
    if (sigaction(SIGPIPE, &ignored, NULL) != 0) return 125;
    status_line("READY", 0);
    /* Node removes the private executable image before sending START. */
    if (!gate(CONTROL, START_MS)) { status_line("DONE", 125); return 125; }
    if (prctl(PR_SET_CHILD_SUBREAPER, 1) != 0) {
        status_line("ERROR", errno);
        status_line("DONE", 125);
        return 125;
    }
    int pair[2];
    if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, pair) != 0) {
        status_line("ERROR", errno);
        status_line("DONE", 125);
        return 125;
    }
    pid_t parent = getpid();
    pid_t guard = fork();
    if (guard < 0) { status_line("ERROR", errno); status_line("DONE", 125); return 125; }
    if (guard == 0) { close(pair[0]); guardian(pair[1], parent, argv[1]); _exit(125); }
    close(pair[1]);
    close(STDIN_FILENO);
    close(STDOUT_FILENO);
    close(STDERR_FILENO);

    int group_ready = 0, root_known = 0, root_status = 0, abnormal = 0;
    long long started = now_ms();
    for (;;) {
        struct pollfd items[2] = {
            { .fd = pair[0], .events = POLLIN },
            { .fd = CONTROL, .events = POLLIN }
        };
        int ready = poll(items, 2, 20);
        if (ready < 0 && errno != EINTR) { abnormal = 1; break; }
        if (items[0].revents & POLLIN) {
            struct report message;
            ssize_t count = read(pair[0], &message, sizeof(message));
            if (count != sizeof(message)) { abnormal = 1; break; }
            if (message.kind == GROUP_READY && !group_ready) {
                group_ready = 1;
                if (write(pair[0], "A", 1) != 1) { abnormal = 1; break; }
            } else if (message.kind == ROOT_EXIT && group_ready) {
                root_status = message.value;
                root_known = 1;
                break;
            } else if (message.kind == EXEC_ERROR && group_ready) {
                status_line("ERROR", message.value);
                break;
            } else { abnormal = 1; break; }
        }
        if (items[1].revents & (POLLIN | POLLHUP | POLLERR)) break;
        siginfo_t observed = {0};
        if (waitid(P_PID, (id_t)guard, &observed, WEXITED | WNOHANG | WNOWAIT) != 0) {
            /* No owned waitable identity, so no destructive numeric fallback. */
            status_line("UNCONFIRMED", 1);
            return 125;
        }
        if (observed.si_pid == guard || (items[0].revents & (POLLHUP | POLLERR))) {
            abnormal = 1;
            break;
        }
        if (!group_ready && now_ms() - started > START_MS) { abnormal = 1; break; }
    }

    /* There is no waitpid before this final signal. Normal SIGCHLD disposition
     * and sole parenthood pin guard's kernel identifier even if it just died. */
    siginfo_t held = {0};
    if (waitid(P_PID, (id_t)guard, &held, WEXITED | WNOHANG | WNOWAIT) != 0) {
        status_line("UNCONFIRMED", 2);
        return 125;
    }
    if (held.si_pid == guard) abnormal = 1;
    int signalled = kill(group_ready ? -guard : guard, SIGKILL);
    if (signalled != 0 && errno != ESRCH) abnormal = 1;
    /* Signal authority is now permanently closed. Reaping below can release
     * the number; absolutely no numeric signal is sent after this point. */
    close(pair[0]);
    long long deadline = now_ms() + CLEANUP_MS;
    for (;;) {
        int result;
        pid_t child = waitpid(-1, &result, WNOHANG);
        if (child > 0) continue;
        if (child < 0 && errno == ECHILD) {
            if (abnormal) { status_line("UNCONFIRMED", 3); return 125; }
            int exit_code = root_known
                ? (WIFEXITED(root_status) ? WEXITSTATUS(root_status) : 128 + WTERMSIG(root_status))
                : 125;
            status_line("DONE", exit_code);
            return exit_code;
        }
        if (child < 0 && errno != EINTR) break;
        if (now_ms() >= deadline) break;
        struct timespec pause_time = { .tv_sec = 0, .tv_nsec = 10000000 };
        nanosleep(&pause_time, NULL);
    }
    status_line("UNCONFIRMED", 4);
    return 125;
}
