// Reads the accessibility tree from inside a phone process and serves it on a Unix socket.
//
// x86Sim adds this library to DYLD_INSERT_LIBRARIES of every phone process (X86SIM_INSERT). A process that has UIKit
// loaded starts a listener at /Volumes/SystemRoot/run/user/<uid>/x86sim-ax-<SIMULATOR_UDID>-<pid>.sock. Linux sees
// that file as /run/user/<uid>/x86sim-ax-<udid>-<pid>.sock. A client sends "tree\n" and gets one line of JSON back,
// then the hook closes the connection:
//
//   { "pid": 123, "bundleId": "com.apple.Preferences", "root": AxNode }
//
// SpringBoard's answer also says which app is in front, since a suspended app cannot answer and only SpringBoard knows:
//
//   { "pid": 80, "bundleId": "com.apple.springboard", "front": { "pid": 123, "bundleId": "..." } | null, "root": AxNode }
//
// "tree debug\n" adds each element's class and accessibility traits, which a reader of the shape ignores.
// AxNode is the shape of packages/server/src/types.ts. The walk runs on the main queue and follows UIKit's
// accessibility containers and subviews the way VoiceOver does. The library links nothing but libobjc and libSystem,
// so a daemon that never loads UIKit pays nothing for it. UIKit is reached through the Objective-C runtime.
#include <dispatch/dispatch.h>
#include <mach-o/dyld.h>
#include <objc/message.h>
#include <objc/runtime.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

typedef struct { double x, y, w, h; } Rect;

void *objc_autoreleasePoolPush(void);
void objc_autoreleasePoolPop(void *pool);

#define SEL_(s) sel_registerName(s)
#define SEND(ret, obj, name) ((ret (*)(id, SEL))objc_msgSend)((obj), SEL_(name))
#define SEND1(ret, argType, obj, name, arg) ((ret (*)(id, SEL, argType))objc_msgSend)((obj), SEL_(name), (arg))

static const char kSystemRoot[] = "/Volumes/SystemRoot";
static const int kMaxDepth = 60;
static const int kMaxNodes = 4000;

// ---- Objective-C helpers -------------------------------------------------------------------------------------

static bool responds(id o, const char *sel) { return o && SEND1(bool, SEL, o, "respondsToSelector:", SEL_(sel)); }
static id get(id o, const char *sel) { return responds(o, sel) ? SEND(id, o, sel) : nil; }
static bool getb(id o, const char *sel) { return responds(o, sel) && SEND(bool, o, sel); }
static long getl(id o, const char *sel) { return responds(o, sel) ? SEND(long, o, sel) : 0; }
static double getd(id o, const char *sel) { return responds(o, sel) ? SEND(double, o, sel) : 0; }
static Rect getrect(id o, const char *sel) { return responds(o, sel) ? SEND(Rect, o, sel) : (Rect){ 0 }; }
static unsigned long count(id a) { return a ? SEND(unsigned long, a, "count") : 0; }
static id at(id a, unsigned long i) { return SEND1(id, unsigned long, a, "objectAtIndex:", i); }

static const char *utf8(id s) {
	if (!s) return NULL;
	if (!responds(s, "UTF8String")) {
		// an attributed string answers with its plain text
		id plain = get(s, "string");
		return plain && responds(plain, "UTF8String") ? SEND(const char *, plain, "UTF8String") : NULL;
	}
	return SEND(const char *, s, "UTF8String");
}

static bool kind(id o, const char *cls) {
	Class c = objc_getClass(cls);
	return o && c && SEND1(bool, Class, o, "isKindOfClass:", c);
}

// ---- a growing JSON buffer (main queue only) ---------------------------------------------------------------

static char *buf;
static size_t len, cap;

static void put(const char *s, size_t n) {
	if (len + n + 1 > cap) {
		cap = (len + n + 1) * 2;
		buf = realloc(buf, cap);
	}
	memcpy(buf + len, s, n);
	len += n;
	buf[len] = 0;
}
static void puts_(const char *s) { put(s, strlen(s)); }
static void putf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void putf(const char *fmt, ...) {
	char t[256];
	va_list ap;
	va_start(ap, fmt);
	int n = vsnprintf(t, sizeof t, fmt, ap);
	va_end(ap);
	if (n > 0) put(t, (size_t)n < sizeof t ? (size_t)n : sizeof t - 1);
}
static void putstr(const char *s) {
	puts_("\"");
	for (const unsigned char *p = (const unsigned char *)(s ? s : ""); *p; p++) {
		if (*p == '"' || *p == '\\') { char t[2] = { '\\', (char)*p }; put(t, 2); }
		else if (*p == '\n') puts_("\\n");
		else if (*p == '\r') puts_("\\r");
		else if (*p == '\t') puts_("\\t");
		else if (*p < 0x20) putf("\\u%04x", *p);
		else put((const char *)p, 1);
	}
	puts_("\"");
}

// ---- the walk ---------------------------------------------------------------------------------------------

enum {
	TraitButton = 1ul << 0, TraitLink = 1ul << 1, TraitImage = 1ul << 2, TraitStaticText = 1ul << 6,
	TraitNotEnabled = 1ul << 8, TraitSearchField = 1ul << 10, TraitHeader = 1ul << 16,
	TraitTextEntry = 1ul << 18,  // UIKit's private trait for text entry
};

static Rect g_screen;
static int g_nodes;
static bool g_debug;

static const char *type_of(id e, unsigned long traits) {
	if (kind(e, "UITextField")) return getb(e, "isSecureTextEntry") ? "SecureTextField" : "TextField";
	if (kind(e, "UITextView")) return "TextView";
	if (kind(e, "UISwitch")) return "Switch";
	if (kind(e, "UISlider")) return "Slider";
	if (kind(e, "UITableViewCell") || kind(e, "UICollectionViewCell")) return "Cell";
	if (traits & TraitSearchField) return "SearchField";
	if (traits & TraitTextEntry) return "TextField";
	if (traits & TraitLink) return "Link";
	if (traits & TraitButton) return "Button";
	if (traits & TraitImage) return "Image";
	if (traits & (TraitStaticText | TraitHeader)) return "StaticText";
	return "Other";
}

static bool intersects_screen(Rect f) {
	return f.w > 0 && f.h > 0 && f.x < g_screen.x + g_screen.w && f.x + f.w > g_screen.x && f.y < g_screen.y + g_screen.h &&
	       f.y + f.h > g_screen.y;
}

/// One accessibility element as a leaf node. A child that is not on screen or has no size is not worth a ref.
static void emit_element(id e, int *siblings) {
	Rect f = getrect(e, "accessibilityFrame");
	if (f.w <= 0 || f.h <= 0) return;
	if (g_nodes >= kMaxNodes) return;
	g_nodes++;
	unsigned long traits = (unsigned long)getl(e, "accessibilityTraits");
	const char *label = utf8(get(e, "accessibilityLabel"));
	const char *value = utf8(get(e, "accessibilityValue"));
	const char *ident = utf8(get(e, "accessibilityIdentifier"));
	bool field = kind(e, "UITextField") || kind(e, "UITextView");
	if (field) {  // the text itself, and the placeholder as its label
		if (!value) value = utf8(get(e, "text"));
		if (!label) label = utf8(get(e, "placeholder"));
	}
	bool enabled = !(traits & TraitNotEnabled) && (!responds(e, "isEnabled") || getb(e, "isEnabled"));
	if (*siblings > 0) puts_(",");
	(*siblings)++;
	putf("{\"type\":\"XCUIElementType%s\"", type_of(e, traits));
	if (ident && *ident) { puts_(",\"name\":"); putstr(ident); }
	if (label && *label) { puts_(",\"label\":"); putstr(label); }
	if (value && *value) { puts_(",\"value\":"); putstr(value); }
	putf(",\"frame\":{\"x\":%.2f,\"y\":%.2f,\"width\":%.2f,\"height\":%.2f},\"enabled\":%s,\"visible\":%s", f.x, f.y, f.w, f.h,
	     enabled ? "true" : "false", intersects_screen(f) ? "true" : "false");
	if (g_debug) putf(",\"class\":\"%s\",\"traits\":%lu", object_getClassName(e), traits);
	puts_(",\"children\":[]}");
}

/// Emits the accessibility elements at or below `o` into the open children array of the caller.
static void walk(id o, int depth, int *siblings) {
	if (!o || depth > kMaxDepth || g_nodes >= kMaxNodes) return;
	if (getb(o, "accessibilityElementsHidden")) return;
	if (kind(o, "UIView") && (getb(o, "isHidden") || getd(o, "alpha") < 0.01)) return;
	if (getb(o, "isAccessibilityElement")) {
		emit_element(o, siblings);
		return;
	}
	id kids = get(o, "accessibilityElements");
	if (kids && count(kids) > 0) {
		for (unsigned long i = 0, n = count(kids); i < n; i++) walk(at(kids, i), depth + 1, siblings);
		return;
	}
	long n = getl(o, "accessibilityElementCount");
	if (n > 0 && n < 100000) {
		for (long i = 0; i < n; i++) walk(SEND1(id, long, o, "accessibilityElementAtIndex:", i), depth + 1, siblings);
		return;
	}
	if (kind(o, "UIView")) {
		id subs = get(o, "subviews");
		for (unsigned long i = 0, m = count(subs); i < m; i++) walk(at(subs, i), depth + 1, siblings);
	}
}

static id shared_application(void) {
	Class c = objc_getClass("UIApplication");
	return c && responds((id)c, "sharedApplication") ? SEND(id, (id)c, "sharedApplication") : nil;
}

static bool is_springboard(void) { return strcmp(getprogname(), "SpringBoard") == 0; }

static const char *bundle_id(void) {
	Class c = objc_getClass("NSBundle");
	id main = c ? get((id)c, "mainBundle") : nil;
	const char *id_ = utf8(get(main, "bundleIdentifier"));
	return id_ ? id_ : is_springboard() ? "com.apple.springboard" : getprogname();
}

/// Is `app`, an SBApplication, running in the foreground? On success `bundle` and `pid` say which. Foreground system
/// UI such as the keyboard's InputUI process is not an app.
static bool foreground_app(id app, const char **bundle, long *pid) {
	id state = get(app, "processState");
	const char *b = utf8(get(app, "bundleIdentifier"));
	if (!state || !getb(state, "isForeground") || !b || strstr(b, "InputUI")) return false;
	*bundle = b;
	*pid = getl(state, "pid");
	return true;
}

/// SpringBoard only: the app in front, or null on the home screen. SpringBoard names it directly when it can, and
/// otherwise the running application that is in the foreground is the one.
static void put_front(id springboard) {
	const char *bundle = NULL;
	long pid = 0;
	bool found = foreground_app(get(springboard, "_accessibilityFrontMostApplication"), &bundle, &pid);
	Class controllerClass = objc_getClass("SBApplicationController");
	id running = controllerClass ? get(get((id)controllerClass, "sharedInstanceIfExists"), "runningApplications") : nil;
	for (unsigned long i = 0, n = count(running); !found && i < n; i++) found = foreground_app(at(running, i), &bundle, &pid);
	if (!found) {
		puts_(",\"front\":null");
	} else {
		putf(",\"front\":{\"pid\":%ld,\"bundleId\":", pid);
		putstr(bundle);
		puts_("}");
	}
	if (!g_debug) return;
	puts_(",\"runningApplications\":[");
	for (unsigned long i = 0, n = count(running); i < n; i++) {
		id app = at(running, i), state = get(app, "processState");
		putf("%s{\"bundleId\":", i ? "," : "");
		putstr(utf8(get(app, "bundleIdentifier")));
		putf(",\"pid\":%ld,\"foreground\":%s,\"state\":\"%s\"}", getl(state, "pid"), getb(state, "isForeground") ? "true" : "false",
		     state ? object_getClassName(state) : "none");
	}
	puts_("]");
	id named = get(springboard, "_accessibilityFrontMostApplication");
	putf(",\"frontMostApplication\":\"%s\"", named ? object_getClassName(named) : "nil");
}

static void build_tree(void) {
	len = 0;
	g_nodes = 0;
	id app = shared_application();
	Class screenClass = objc_getClass("UIScreen");
	id screen = screenClass ? get((id)screenClass, "mainScreen") : nil;
	g_screen = getrect(screen, "bounds");
	putf("{\"pid\":%d,\"bundleId\":", getpid());
	putstr(bundle_id());
	if (is_springboard()) put_front(app);
	puts_(",\"root\":{\"type\":\"XCUIElementTypeApplication\",\"label\":");
	putstr(getprogname());
	putf(",\"frame\":{\"x\":%.2f,\"y\":%.2f,\"width\":%.2f,\"height\":%.2f},\"enabled\":true,\"visible\":true,\"children\":[", g_screen.x,
	     g_screen.y, g_screen.w, g_screen.h);
	id windows = get(app, "windows");
	int windowCount = 0;
	for (unsigned long i = 0, n = count(windows); i < n; i++) {
		id win = at(windows, i);
		if (getb(win, "isHidden") || getd(win, "alpha") < 0.01) continue;
		// A window with no element leaves no trace: it is written first, and taken back when the walk finds nothing.
		size_t mark = len;
		Rect f = getrect(win, "frame");
		putf("%s{\"type\":\"XCUIElementTypeWindow\",\"frame\":{\"x\":%.2f,\"y\":%.2f,\"width\":%.2f,\"height\":%.2f},", windowCount > 0 ? "," : "", f.x, f.y, f.w, f.h);
		puts_("\"enabled\":true,\"visible\":true,\"children\":[");
		int siblings = 0;
		walk(win, 0, &siblings);
		if (siblings == 0) {  // nothing in it, so it leaves no trace
			len = mark;
			buf[len] = 0;
			continue;
		}
		puts_("]}");
		windowCount++;
	}
	puts_("]}}\n");
}

// ---- the socket -------------------------------------------------------------------------------------------

static void write_all(int fd, const char *data, size_t n) {
	while (n > 0) {
		ssize_t w = write(fd, data, n);
		if (w <= 0) return;
		data += w;
		n -= (size_t)w;
	}
}

/// Runs on the main queue. It answers and closes the connection itself, so a stalled main queue costs a waiting client
/// and nothing else.
static void answer(void *ctx) {
	int fd = (int)(intptr_t)ctx & 0xffffff, debug = (int)((intptr_t)ctx >> 24);
	g_debug = debug != 0;
	void *pool = objc_autoreleasePoolPush();
	build_tree();
	objc_autoreleasePoolPop(pool);
	write_all(fd, buf, len);
	close(fd);
}

static void *serve_client(void *arg) {
	int fd = (int)(intptr_t)arg;
	char line[64];
	size_t n = 0;
	while (n < sizeof line - 1) {
		ssize_t r = read(fd, line + n, 1);
		if (r <= 0 || line[n] == '\n') break;
		n++;
	}
	line[n] = 0;
	if (strcmp(line, "tree") == 0 || strcmp(line, "tree debug") == 0) {
		intptr_t ctx = fd | (strcmp(line, "tree debug") == 0 ? (intptr_t)1 << 24 : 0);  // descriptors are small
		dispatch_async_f(dispatch_get_main_queue(), (void *)ctx, answer);
	} else {
		write_all(fd, "{\"error\":\"unknown request\"}\n", 28);
		close(fd);
	}
	return NULL;
}

/// Where the socket lives. A path longer than sockaddr_un's 104 bytes cannot be bound, so it sits in the short
/// directory x86Sim keeps its frame ring in (/run/user/<uid>), which is the same place on Linux.
static bool socket_path(char *out, size_t size) {
	const char *udid = getenv("SIMULATOR_UDID");
	const char *ring = getenv("SIMFB_RING");
	const char *slash = ring ? strrchr(ring, '/') : NULL;
	char dir[256];
	if (slash && strncmp(ring, kSystemRoot, sizeof kSystemRoot - 1) == 0) snprintf(dir, sizeof dir, "%.*s", (int)(slash - ring), ring);
	else snprintf(dir, sizeof dir, "%s/run/user/%u", kSystemRoot, (unsigned)getuid());
	int w = snprintf(out, size, "%s/x86sim-ax-%s-%d.sock", dir, udid && *udid ? udid : "unknown", getpid());
	return w > 0 && (size_t)w < size;
}

static void *listen_thread(void *arg) {
	struct sockaddr_un addr = { 0 };
	char path[sizeof addr.sun_path];
	if (!socket_path(path, sizeof path)) return NULL;
	int s = socket(AF_UNIX, SOCK_STREAM, 0);
	if (s < 0) return NULL;
	addr.sun_family = AF_UNIX;
	strlcpy(addr.sun_path, path, sizeof addr.sun_path);
	unlink(path);
	if (bind(s, (struct sockaddr *)&addr, sizeof addr) != 0 || listen(s, 8) != 0) {
		close(s);
		return NULL;
	}
	for (;;) {
		// Darling's accept() crashes with a NULL address, so pass a real one.
		struct sockaddr_un peer;
		socklen_t peerLen = sizeof peer;
		int c = accept(s, (struct sockaddr *)&peer, &peerLen);
		if (c < 0) {
			usleep(100000);
			continue;
		}
		int one = 1;
		setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
		pthread_t t;
		if (pthread_create(&t, NULL, serve_client, (void *)(intptr_t)c) == 0) pthread_detach(t);
		else close(c);
	}
	return NULL;
}

// ---- start-up ---------------------------------------------------------------------------------------------

static void image_added(const struct mach_header *mh, intptr_t slide) {
	static bool started;
	if (started || !objc_getClass("UIApplication")) return;
	started = true;
	pthread_t t;
	if (pthread_create(&t, NULL, listen_thread, NULL) == 0) pthread_detach(t);
}

__attribute__((constructor)) static void init(void) { _dyld_register_func_for_add_image(image_added); }
