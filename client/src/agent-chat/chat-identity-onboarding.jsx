import { UserOutlined } from "@ant-design/icons";
import { Button, Input } from "antd";
import { normalizeUserLabel } from "./chat-ui-utils.js";

export function ChatIdentityOnboarding({ value, onChange, onSubmit, maxLength }) {
  const normalized = normalizeUserLabel(value);
  return (
    <div className="ai-chat-identity-gate">
      <form
        className="ai-chat-identity-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="ai-chat-identity-icon" aria-hidden="true">
          <UserOutlined />
        </div>
        <h1>Welcome</h1>
        <p>Enter your name to start chatting.</p>
        <Input
          size="large"
          autoFocus
          maxLength={maxLength}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Your name"
          prefix={<UserOutlined />}
          aria-label="Your name"
        />
        <Button type="primary" htmlType="submit" size="large" block disabled={!normalized}>
          Continue
        </Button>
      </form>
    </div>
  );
}
