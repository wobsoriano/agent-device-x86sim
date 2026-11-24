import SwiftUI

// A tiny test app for driving with agent-device: type a name, press the button, read the greeting.
// The accessibility identifiers are stable so tests can find elements without depending on labels.

@main
struct HelloApp: App {
    var body: some Scene {
        WindowGroup {
            GreetingView()
                .preferredColorScheme(.dark)
        }
    }
}

private enum Palette {
    static let backgroundTop = Color(red: 0.043, green: 0.051, blue: 0.071)
    static let backgroundBottom = Color(red: 0.067, green: 0.082, blue: 0.110)
    static let card = Color(red: 0.090, green: 0.106, blue: 0.141)
    static let field = Color(red: 0.118, green: 0.137, blue: 0.180)
    static let border = Color.white.opacity(0.08)
    static let accent = Color(red: 0.388, green: 0.400, blue: 0.945)
    static let accentPressed = Color(red: 0.310, green: 0.275, blue: 0.898)
    static let textPrimary = Color(red: 0.945, green: 0.953, blue: 0.969)
    static let textSecondary = Color(red: 0.580, green: 0.612, blue: 0.682)
}

struct GreetingView: View {
    @State private var name = ""
    @State private var greeting: String?
    @FocusState private var fieldFocused: Bool

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Palette.backgroundTop, Palette.backgroundBottom],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            VStack(spacing: 28) {
                header
                card
                Spacer()
            }
            .padding(.horizontal, 24)
            .padding(.top, 72)
        }
    }

    private var header: some View {
        VStack(spacing: 10) {
            Image(systemName: "hand.wave.fill")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(Palette.accent)
                .frame(width: 72, height: 72)
                .background(Palette.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .accessibilityHidden(true)

            Text("Hello")
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .foregroundStyle(Palette.textPrimary)
                .accessibilityAddTraits(.isHeader)

            Text("Tell us your name and we'll say hi.")
                .font(.system(size: 16))
                .foregroundStyle(Palette.textSecondary)
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Your name")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Palette.textSecondary)
                .textCase(.uppercase)
                .accessibilityHidden(true)

            TextField("", text: $name, prompt: Text("Jane Appleseed").foregroundStyle(Palette.textSecondary.opacity(0.6)))
                .font(.system(size: 17))
                .foregroundStyle(Palette.textPrimary)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .focused($fieldFocused)
                .onSubmit(greet)
                .padding(.horizontal, 16)
                .frame(height: 52)
                .background(Palette.field, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(fieldFocused ? Palette.accent : Palette.border, lineWidth: fieldFocused ? 1.5 : 1)
                )
                .accessibilityLabel("Your name")
                .accessibilityIdentifier("nameField")

            Button(action: greet) {
                Text("Say hello")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .frame(height: 52)
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(trimmedName.isEmpty)
            .accessibilityIdentifier("greetButton")

            if let greeting {
                Text(greeting)
                    .font(.system(size: 22, weight: .semibold, design: .rounded))
                    .foregroundStyle(Palette.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.top, 8)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                    .accessibilityIdentifier("greetingLabel")
            }
        }
        .padding(20)
        .background(Palette.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(Palette.border, lineWidth: 1))
        .animation(.easeOut(duration: 0.2), value: greeting)
    }

    private func greet() {
        guard !trimmedName.isEmpty else { return }
        fieldFocused = false
        greeting = "Hello, \(trimmedName)!"
    }
}

private struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(.white.opacity(isEnabled ? 1 : 0.5))
            .background(
                (configuration.isPressed ? Palette.accentPressed : Palette.accent).opacity(isEnabled ? 1 : 0.35),
                in: RoundedRectangle(cornerRadius: 14, style: .continuous)
            )
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}
