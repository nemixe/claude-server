import { Button, Input, Space, Typography } from "antd";
import { UserOutlined } from "@ant-design/icons";
import { useState } from "react";
import { USER_LABEL_MAX_LENGTH } from "./chat-ui-constants";
import { normalizeUserLabel } from "./chat-ui-utils";

const { Title, Text } = Typography;

export default function ChatIdentityOnboarding({
    onJoin,
    initialName = "",
}) {
    const [name, setName] = useState(initialName);

    const handleJoin = () => {
        if (normalizeUserLabel(name)) {
            onJoin(name);
        }
    };

    return (
        <div className="ai-chat-onboarding">
            <div style={{ textAlign: "center", marginBottom: 24 }}>
                <Title level={4} style={{ marginBottom: 8 }}>
                    Welcome to AI Assistant
                </Title>
                <Text type="secondary">
                    Join the chat to collaborate with others.
                </Text>
            </div>

            <Space direction="vertical" size="large" style={{ width: "100%" }}>
                <div>
                    <Text strong>Your Name</Text>
                    <Input
                        placeholder="Enter your name"
                        prefix={<UserOutlined />}
                        maxLength={USER_LABEL_MAX_LENGTH}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onPressEnter={handleJoin}
                        disabled={false} // Add loading state if needed
                    />
                </div>

                <Button
                    type="primary"
                    block
                    onClick={handleJoin}
                    disabled={!normalizeUserLabel(name)}
                >
                    Join Chat
                </Button>
            </Space>
        </div>
    );
}
